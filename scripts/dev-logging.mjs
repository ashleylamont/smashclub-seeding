// Preload before Act imports: it reads LOG_LEVEL during module initialization.
// Preserve explicit debug/trace choices while keeping normal dev terminals quiet.
process.env.LOG_LEVEL ??= 'warn';
