/**
 * Runtime warnings that can fire mid-session (harness stop-reasons, bad
 * persona files during routing). Default sink is console.error — right for
 * CLI subcommands and startup. The TUI swaps the sink in once it owns the
 * terminal in raw mode, where a stray stderr write would smear the render;
 * everything else just calls notice() and doesn't care which is active.
 */
type NoticeSink = (text: string) => void;

let sink: NoticeSink = (text) => console.error(text);

export function setNoticeSink(fn: NoticeSink): void {
  sink = fn;
}

export function notice(text: string): void {
  sink(text);
}
