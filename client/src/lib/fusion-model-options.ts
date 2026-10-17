import { buildModelOptions, type PickerEntry } from './model-groups'

// Keep saved full IDs visible without silently rewriting them to group IDs:
// full IDs deliberately pin a literal model, while canonical IDs select a group.
export function buildFusionModelOptions(entries: PickerEntry[], unifyOn: boolean, saved: string[]) {
  const options = buildModelOptions(entries, unifyOn)
  const values = new Set(options.map(o => o.value))
  for (const id of saved) {
    if (values.has(id)) continue
    const entry = entries.find(e => e.modelId === id)
    if (!entry) continue
    const [option] = buildModelOptions([entry], false)
    options.push({ ...option, label: `${option.label} (${entry.platform}: ${id})` })
    values.add(id)
  }
  return options
}
