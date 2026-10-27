// Node 22 marks node:sqlite experimental and prints a warning on every start. It is stable for our use.
// Import this module before node:sqlite so the warning never reaches stderr.
const originalEmit = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const text = typeof warning === 'string' ? warning : warning?.message || '';
  if (text.includes('SQLite is an experimental feature')) return;
  return originalEmit.call(process, warning, ...rest);
};
