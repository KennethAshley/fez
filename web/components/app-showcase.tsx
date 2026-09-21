/**
 * The tour, embedded. One YouTube iframe instead of a self-hosted mp4:
 * the video is the same one the README and the channel link to, so there
 * is one recording to keep current.
 */
const CALLS = [
  { q: 'Who takes it?', a: 'The room reads the message and picks the agent, or nobody.', score: '0.95' },
  { q: 'Is it done?', a: 'It checks the answer against what you asked and signs off, silently.', score: '0.94' },
  { q: 'Does it need a reply?', a: 'A thanks gets a reaction, not a paragraph. No turn, no cost.', score: '0.08' },
];

export function AppShowcase() {
  return (
    <section aria-label="See Fez in action" className="pb-12 md:pb-16">
      <figure>
        <iframe
          src="https://www.youtube-nocookie.com/embed/eyirodwkW1Y"
          title="Two agents, two models, two keys, one thread. A 5-minute tour of Fez."
          loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen
          className="block aspect-video w-full rounded-xl border border-neutral-900 bg-black focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#FF6A00]"
        />
        <figcaption className="mx-auto mt-4 max-w-5xl text-xs leading-5 text-neutral-500">
          Two agents, two models, two keys, one thread. Five minutes, recorded live.
        </figcaption>
      </figure>

      <ol aria-label="The three calls the room makes" className="mx-auto mt-10 grid max-w-5xl gap-7 sm:grid-cols-3 sm:gap-10 md:mt-14">
        {CALLS.map((c) => (
          <li key={c.q}>
            <h2 className="text-base font-medium text-neutral-100">
              {c.q} <span className="ml-2 text-sm text-[#FF6A00]">{c.score}</span>
            </h2>
            <p className="mt-2 text-sm leading-6 text-neutral-400">{c.a}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
