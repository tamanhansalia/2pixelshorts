/** Tokenize console arguments without evaluating shells, variables or commands. */
export function parseCliArguments(input: string): string[] {
  const args: string[] = [];
  let value = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === "\\" && quote !== "'" && i + 1 < input.length &&
        (input[i + 1] === '"' || (!quote && /\s/.test(input[i + 1])))) {
      value += input[++i];
      started = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else value += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) { args.push(value); value = ""; started = false; }
    } else {
      value += char;
      started = true;
    }
  }
  if (quote) throw new Error("Close the quoted argument before running the command");
  if (started) args.push(value);
  return args;
}
