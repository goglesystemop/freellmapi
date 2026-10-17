import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { resolveFusionCandidate, setRoutingStrategy } from '../../services/router.js';

// A fusion unit-test fixture: seed the standard catalog, then add one healthy
// key per platform so the auto-panel chain has servable members (the seed ships
// no keys by default). Priority strategy keeps the panel order deterministic.
function addKey(platform: string): void {
  const { encrypted, iv, authTag } = encrypt(`test-${platform}-key`);
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'fusion-vision-test', ?, ?, ?, 'healthy', 1)
  `).run(platform, encrypted, iv, authTag);
}

describe('selectPanel vision filtering', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    setRoutingStrategy('priority');
  });

  beforeEach(() => {
    initDb(':memory:');
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    const models = db.prepare('SELECT id, intelligence_rank FROM models ORDER BY intelligence_rank ASC').all() as any[];
    const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');
    for (let i = 0; i < models.length; i++) update.run(i + 1, models[i].id);
    addKey('google');
    addKey('groq');
  });

  it('drops explicit panel models without vision support when requireVision', async () => {
    const { selectPanel } = await import('../../services/fusion.js');
    const config = { models: ['gemini-2.5-flash', 'llama-3.1-8b-instant'], k: 2, judge: null, strategy: 'synthesize' as const, expose_panel: false };
    const { panel, dropped } = selectPanel(config, { requireVision: true, estimatedTokens: 100 });
    expect(panel.every((c) => c.supportsVision === 1)).toBe(true);
    expect(panel.some((c) => c.modelId === 'gemini-2.5-flash')).toBe(true);
    expect(panel.some((c) => c.modelId === 'llama-3.1-8b-instant')).toBe(false);
    expect(dropped).toContain('llama-3.1-8b-instant (no vision support)');
  });

  it('auto panel only contains vision models when requireVision', async () => {
    const { selectPanel } = await import('../../services/fusion.js');
    const config = { k: 4, judge: null, strategy: 'synthesize' as const, expose_panel: false };
    const { panel } = selectPanel(config, { requireVision: true, estimatedTokens: 100 });
    expect(panel.length).toBeGreaterThan(0);
    expect(panel.every((c) => c.supportsVision === 1)).toBe(true);
  });

  it('explicit unified aliases prefer a keyed provider over a keyless duplicate', () => {
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
      VALUES (?, ?, ?, ?, ?, 1)
    `);
    // Make the keyless row win the normal deterministic ordering. The fusion
    // resolver must still choose the configured provider for the same logical
    // alias rather than spending a panel slot on a dead relay.
    insert.run('kilo', 'edge-case-model', 'Edge Case Model (Kilo)', 1, 1);
    insert.run('nvidia', 'edge-case-model', 'Edge Case Model (NVIDIA)', 2, 2);
    addKey('nvidia');

    try {
      const candidate = resolveFusionCandidate('edge-case-model');
      expect(candidate?.platform).toBe('nvidia');
      expect(candidate?.modelId).toBe('edge-case-model');
    } finally {
      db.prepare("DELETE FROM models WHERE model_id = 'edge-case-model'").run();
    }
  });

  it.each([
    ['gpt-oss-20b', 'openai/gpt-oss-20b', 'ovh', 'GPT OSS 20B'],
    ['qwen3.8-27b', 'qwen/qwen3.8-27b', 'electronhub', 'Qwen3.8 27B'],
  ])('resolves canonical %s across differently named provider ids', (alias, full, relay, name) => {
    const db = getDb();
    db.prepare('UPDATE models SET enabled = 0').run();
    const insert = db.prepare(`INSERT INTO models
      (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
      VALUES (?, ?, ?, ?, 1, 1) ON CONFLICT DO UPDATE SET enabled = 1, display_name = excluded.display_name, intelligence_rank = excluded.intelligence_rank`);
    insert.run(relay, alias, name, 1);
    insert.run('groq', full, name, 2);
    expect(resolveFusionCandidate(alias)).toMatchObject({ platform: 'groq', modelId: full });
    expect(resolveFusionCandidate(full)).toMatchObject({ platform: 'groq', modelId: full });
    db.prepare("UPDATE api_keys SET model_scope_json = ? WHERE platform = 'groq'").run(JSON.stringify(['other-model']));
    expect(resolveFusionCandidate(alias)?.platform).toBe(relay);
    db.prepare("UPDATE api_keys SET model_scope_json = NULL, enabled = 0 WHERE platform = 'groq'").run();
    expect(resolveFusionCandidate(alias)?.platform).toBe(relay);
    db.prepare("UPDATE api_keys SET enabled = 1, status = 'unknown' WHERE platform = 'groq'").run();
    expect(resolveFusionCandidate(alias)?.platform).toBe('groq');
    db.prepare('UPDATE models SET enabled = 0 WHERE platform = ?').run('groq');
    expect(resolveFusionCandidate(alias)?.platform).toBe(relay);
  });

  it('keeps full ids literal even when a different group member has a key', () => {
    const db = getDb();
    db.prepare('UPDATE models SET enabled = 0').run();
    const insert = db.prepare(`INSERT INTO models
      (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
      VALUES (?, ?, 'Literal Test Model', 1, 1, 1)`);
    insert.run('ovh', 'vendor/literal-test');
    insert.run('groq', 'other/literal-test');
    expect(resolveFusionCandidate('vendor/literal-test')).toMatchObject({ platform: 'ovh', modelId: 'vendor/literal-test' });
    expect(resolveFusionCandidate('unknown-model')).toBeNull();
  });
});

describe('fusion vision judge', () => {
  it('buildJudgeMessages strips image blocks when vision is requested', async () => {
    const { buildJudgeMessages } = await import('../../services/fusion.js');
    const original = [
      { role: 'user' as const, content: [
        { type: 'text', text: 'what is in this image?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ] },
    ];
    const answers = [
      { status: 'ok' as const, content: 'a red square', usage: undefined } as any,
    ];
    const judgeMessages = buildJudgeMessages(original, answers, true);
    const hasImage = judgeMessages.some((m) =>
      Array.isArray(m.content) && m.content.some((b: any) => b?.type === 'image_url' || b?.type === 'image'),
    );
    expect(hasImage).toBe(false);
  });

  it('keeps image blocks by default (no strip flag)', async () => {
    const { buildJudgeMessages } = await import('../../services/fusion.js');
    const original = [
      { role: 'user' as const, content: [
        { type: 'text', text: 'what is in this image?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ] },
    ];
    const answers = [
      { status: 'ok' as const, content: 'a red square', usage: undefined } as any,
    ];
    const judgeMessages = buildJudgeMessages(original, answers);
    const hasImage = judgeMessages.some((m) =>
      Array.isArray(m.content) && m.content.some((b: any) => b?.type === 'image_url' || b?.type === 'image'),
    );
    expect(hasImage).toBe(true);
  });
});
