export const CLI_COMMANDS = [
  "join",
  "leave",
  "reconnect",
  "status",
  "chat",
  "cmd",
  "goto",
  "look",
  "turn",
  "walk",
  "jump",
  "stop",
  "attack",
  "dig",
  "players",
  "inv",
  "view",
  "voxels",
  "map",
  "dump",
  "catalog",
  "hunt",
  "unhunt",
  "map-start",
  "map-stop",
  "map-status",
  "shell",
  "completion",
  "help",
] as const;

export const WALK_DIRECTIONS = ["forward", "back", "left", "right", "jump", "sprint", "sneak"] as const;

export function complete(args: string[]): string[] {
  const last = args.at(-1) ?? "";
  if (args.length <= 1) {
    return prefix(CLI_COMMANDS, last);
  }
  const command = args[0];
  if (command === "walk") return prefix(WALK_DIRECTIONS, last);
  if (command === "inv") return prefix(["hold", "drop", "toss", "equip", "unequip", "use", "swap"], last);
  if (command === "completion") return prefix(["install", "bash", "zsh"], last);
  if (command === "join") return prefix(["--host", "--port", "--username", "--daemon", "--no-lobby"], last);
  return [];
}

function prefix(options: readonly string[], last: string): string[] {
  return options.filter((option) => option.startsWith(last));
}

export function renderCompletionScript(shell: "bash" | "zsh", bin = "fractalbot"): string {
  if (shell === "zsh") {
    return `#compdef ${bin}
# Add to ~/.zshrc: eval "$(${bin} completion zsh)"

_${bin}_complete() {
  local -a suggestions
  suggestions=(\${(f)"$(\${words[1]} --complete -- \${words[2,-1]} 2>/dev/null)"})
  _describe 'command' suggestions
}

compdef _${bin}_complete ${bin}
`;
  }

  return `# Add to ~/.bashrc: eval "$(${bin} completion bash)"
_${bin}_complete() {
  local cur
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  local suggestions
  suggestions="$(\${COMP_WORDS[0]} --complete -- "\${COMP_WORDS[@]:1}" 2>/dev/null)"
  COMPREPLY=( $(compgen -W "\${suggestions}" -- "\${cur}") )
  return 0
}
complete -F _${bin}_complete ${bin}
`;
}
