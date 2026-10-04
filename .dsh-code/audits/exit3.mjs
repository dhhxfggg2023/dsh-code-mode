/**
 * Audit fixture: a command that prints a banner and then fails.
 * Used to ask what `code_verify` records as the exit code of a *pipeline*.
 */
console.log('BANNER: this line is printed before the failure');
console.error('ERROR: the payload failed');
process.exit(3);
