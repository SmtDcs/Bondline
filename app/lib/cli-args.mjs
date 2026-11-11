// Tiny argv helpers shared by the verify scripts (client-6).

/** Positional arguments: everything that is not a `--flag` and not the value of one of `valueFlags`. */
export function positionalArgs(args, valueFlags = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valueFlags.includes(a)) { i++; continue; }
    if (a.startsWith('--')) continue;
    out.push(a);
  }
  return out;
}

/** Value of `--name <value>` (also `--name=<value>`), or undefined. */
export function flagValue(args, name) {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  const eq = args.find(a => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}
