import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { initLedger, ledgerRoot, matchesExpectation, recordVerified, truncate } from './ledger.js';

export const name = 'code-verify';
export const inject = ['tools', 'shell'];

export const Config = z.object({
  /** Default budget for one verification command. */
  timeoutMs: z.number().default(120000),
});

/** How much raw command output reaches the model; the journal keeps its own tail. */
const SHOWN = 3000;

export function apply(ctx, config) {
  const defaultTimeout = config?.timeoutMs ?? 120000;

  ctx.tools.register(
    defineTool({
      name: 'code_verify',
      description:
        'Run a command and check what it printed. Use it whenever you are about to claim that something works: it runs the command for real, reports the exit code, and writes the evidence into the project journal, so the claim can be checked afterwards instead of trusted. State `expect` as the output that would prove success. A failing exit code is a normal result, not a tool error — read it and fix the cause.',
      parameters: {
        cmd: {
          type: 'string',
          required: true,
          description: 'The command line to run, exactly as you would pass it to the shell tool.',
        },
        expect: {
          type: 'string',
          description:
            'Output that proves success, matched as a substring. Use "re:<pattern>" for a regular expression, or leave it out to require only exit code 0.',
        },
        timeoutMs: {
          type: 'integer',
          description: `Kill the command after this many milliseconds (default ${defaultTimeout}).`,
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            cmd: { type: 'string', required: true },
            exitCode: { type: 'integer', required: true },
            matched: { type: 'boolean', required: true },
            ok: { type: 'boolean', required: true },
            outputTail: { type: 'string', required: true },
            journal: { type: 'string', required: true },
          },
        },
        render: (_args, value) => {
          const verdict = value.ok
            ? 'VERIFIED'
            : value.exitCode === 0
              ? 'exit 0, but the expected output never appeared'
              : `FAILED (exit ${value.exitCode})`;
          return [
            {
              type: 'text',
              text: `$ ${value.cmd}\n${verdict}\n\n${value.outputTail || '(no output)'}\n\nexitCode ${value.exitCode} · expectation ${value.matched ? 'matched' : 'not matched'} · ok ${value.ok}\nLogged to ${value.journal}`,
            },
          ];
        },
      },
      async execute(args, exec) {
        const root = ledgerRoot(exec);
        const sessionId = exec.agent?.session?.id;
        // Run through the host shell service, not child_process: it is the seam that
        // applies the session's sandbox policy and timeout cap, so verification sees
        // exactly what a shell tool call would see and cannot escape confinement.
        if (typeof ctx.shell?.resolve !== 'function' || typeof ctx.shell?.execute !== 'function') {
          throw new Error(
            'code_verify: the host shell service is unavailable in this mode, so no command can be run to verify a claim',
          );
        }
        const timeoutMs = args.timeoutMs === undefined ? defaultTimeout : args.timeoutMs;
        const handle = await ctx.shell.execute(
          ctx.shell.resolve({ command: args.cmd, workdir: root, timeoutMs, onExpiry: 'kill' }),
        );
        const result = await handle.result();
        const output = [result.stdout?.text ?? '', result.stderr?.text ?? '']
          .filter((part) => part.length > 0)
          .join('\n');
        const denied = result.sandbox?.denied === true;
        const runnerFailed = result.sandbox?.runnerFailed === true;
        const exitCode = typeof result.exitCode === 'number' ? result.exitCode : -1;
        const aborted = result.aborted === true || result.timedOut === true;
        const matched = matchesExpectation(output, args.expect);
        const ok = !denied && !runnerFailed && !aborted && exitCode === 0 && matched;
        initLedger(root, sessionId);
        const journal = recordVerified(
          root,
          { cmd: args.cmd, expect: args.expect, ok, tail: truncate(output, 1500) },
          sessionId,
        );
        return {
          cmd: args.cmd,
          exitCode,
          matched,
          ok,
          outputTail: denied
            ? `${output}\n[sandbox denied this command under the session's current file policy]`.trim()
            : runnerFailed
              ? `${output}\n[the sandbox runner failed, so this run proves nothing]`.trim()
              : truncate(output, SHOWN),
          journal,
        };
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `Verify ${args.cmd}`,
        kind: 'execute',
        rawInput: args,
      }),
    }),
  );
}
