import { runCli } from './program.js';

const code = await runCli(process.argv.slice(2), {
  io: {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  },
});
process.exitCode = code;
