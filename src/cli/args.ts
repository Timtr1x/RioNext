export interface ParsedArgs {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

const ALIASES: Record<string, string> = {
  ls: "list",
  accept: "accept",
  reject: "reject",
  continue: "start",
};

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let i = 0;
  if (argv[0] === "campaign") i = 1;
  let cmd = "help";
  if (argv[i] && !argv[i]!.startsWith("-")) {
    cmd = argv[i]!;
    i += 1;
  }
  if (/^https?:\/\//i.test(cmd)) {
    flags.url = cmd;
    cmd = "run";
  }
  cmd = ALIASES[cmd] ?? cmd;
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") flags.json = true;
    else if (a === "--help" || a === "-h") flags.help = true;
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
    } else positional.push(a);
  }
  return { cmd, positional, flags };
}

export function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

export function resolveCampaignId(
  flags: Record<string, string | boolean>,
  positional: string[],
  campaigns: { id: string; state: string }[],
): string {
  const fromFlag = flagString(flags, "id");
  if (fromFlag) return fromFlag;
  if (positional[0]) return positional[0];
  if (campaigns.length === 1) return campaigns[0]!.id;
  if (campaigns.length === 0) throw new Error("no campaigns here. rionext run --url <target>");
  const lines = campaigns.map((c) => `  ${c.id}  ${c.state}`).join("\n");
  throw new Error(`multiple campaigns; pass an id:\n${lines}`);
}

export const HELP = `RioNext campaign CLI

  rionext run --url <http(s)://host/>   one command: Kali flag campaign, solver slot, no spec file
  rionext <http(s)://host/>             same as run --url
  rionext run --spec <file> [--max-cycles 1000] [--progress-ms 300000] [--finalization|--no-finalization]
                                     [--max-execute-turns 72] [--max-tool-calls 144]
                                     create if needed, then start
                                     Execute Finalize is on by default
                                     --no-finalization or RIONEXT_FINALIZATION=0 turns it off
                                     --finalization or RIONEXT_FINALIZATION=1 still force it on
                                     one Execute fragment defaults to 72 model turns and 144 tool calls
  rionext list                       campaigns in this data dir
  rionext status [id]                state, budget, pending flag
  rionext start [id] [--progress-ms 300000] [--finalization|--no-finalization]
                                     [--max-execute-turns 72] [--max-tool-calls 144]
                                     resume Decide/Execute; logs recent calls every 5 min
                                     (--progress-ms 0 turns that off)
  rionext pause|resume|cancel [id]
  rionext accept [id]                human: submitted flag is correct
  rionext reject [id] --text <why> [--continue]
                                     human: flag is wrong; inject why
  rionext hint [id] --text <hint>
  rionext facts|steps|findings|events|operations|report [id]
  rionext observations|invocations|coverage|goals|artifacts [id]
  rionext provider list|show|add|set|key|rm|model|test|slots|ui
                               CLI owns catalog and keys; ui is optional
  rionext kali status|pull|build|protect|smoke
  rionext health

Default data dir is .rionext (override with --data-dir or RIONEXT_DATA).
If there is exactly one campaign, [id] can be omitted.
Budget defaults: 3000 calls, 30_000_000 tokens, 1000 controller cycles.
`;
