// Every JSON value kind, plus malformed envelopes with missing/null fields.
export const malformedRows = [
  { label: 'null', row: null },
  { label: 'array', row: [] },
  { label: 'nested array', row: [null, {}] },
  { label: 'number', row: 42 },
  { label: 'string', row: 'not a receipt' },
  { label: 'boolean', row: false },
  { label: 'object', row: {} },
  { label: 'null event', row: { event: null } },
  { label: 'missing type', row: { event: {}, meta: {} } },
  { label: 'missing receipt', row: { event: { type: 'frozen_receipt' }, meta: null } },
]
