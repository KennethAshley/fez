/**
 * The roster's pixel sprites, drawn as character maps — Qud's sultan-
 * statue grammar: at rest a sprite is a single muted slate, and only
 * the chosen one lights up in color. Lit palettes are 2-3 colors, ember
 * always among them; eyes and seams are punched holes (the black ground
 * does that work for free). '.' is transparent; editing a sprite is
 * editing text, so the art stays reviewable in a diff.
 */

export interface Sprite {
  rows: string[];
  /** Second idle frame, same dimensions — each character moves its OWN
   * way (a tassel swings, a shuttle travels, an eye looks around).
   * Absent = the sprite holds still. */
  alt?: string[];
  palette: Record<string, string>;
}

const BONE = '#e8e2d9';
const EMBER = '#FF6A00';
const DUST = '#6d645a';

export const SPRITES: Record<string, Sprite> = {
  // The guide wears the hat the network is named for.
  fez: {
    palette: { r: EMBER, f: BONE, d: DUST },
    rows: [
      '....rrrr....',
      '....rrrr.r..',
      '...ffffff.r.',
      '...f.ff.f...',
      '...ffffff...',
      '..dddddddd..',
      '..dddddddd..',
      '..ddrrrrdd..',
      '..dddddddd..',
      '...dd..dd...',
      '...dd..dd...',
    ],
    alt: [
      '....rrrr....',
      '....rrrr....',
      '...ffffff.r.',
      '...f.ff.f.r.',
      '...ffffff...',
      '..dddddddd..',
      '..dddddddd..',
      '..ddrrrrdd..',
      '..dddddddd..',
      '..dd....dd..',
      '..dd....dd..',
    ],
  },
  // Subnet cartographer: wide-brim hat, an ember spyglass to the eye.
  scout: {
    palette: { t: '#6fb3b8', f: BONE, r: EMBER },
    rows: [
      '..tttttttt..',
      '....tttt....',
      '....ffff....',
      '....f.ffrrrr',
      '....ffff.r..',
      '...tttttt...',
      '...tttttt...',
      '...tttttt...',
      '....t..t....',
      '....t..t....',
    ],
    alt: [
      '..tttttttt..',
      '....tttt....',
      '....ffff....',
      '....f.ffrr..',
      '....ffff....',
      '...tttttt...',
      '...tttttt...',
      '...tttttt...',
      '...t....t...',
      '...t....t...',
    ],
  },
  // The weaver is its loom: violet frame, one ember shuttle.
  loom: {
    palette: { v: '#9d6fcf', r: EMBER },
    rows: [
      '..v......v..',
      '..vvvvvvvv..',
      '..v.v.v..v..',
      '..v.v.v.vv..',
      '..vrrrrrrv..',
      '..vv..v..v..',
      '..vv.vv.vv..',
      '..vvvvvvvv..',
      '..v......v..',
    ],
    alt: [
      '..v......v..',
      '..vvvvvvvv..',
      '..v.v.v..v..',
      '..v.v.v.vv..',
      '..v.v.v..v..',
      '..vrrrrrrv..',
      '..vv.vv.vv..',
      '..vvvvvvvv..',
      '..v......v..',
    ],
  },
  // Keeper of the deep: a strongbox, ember light in the keyhole.
  vault: {
    palette: { g: '#cfc041', r: EMBER },
    rows: [
      '...gggggg...',
      '..gggggggg..',
      '............',
      '..gggggggg..',
      '..gggrrggg..',
      '..ggggrggg..',
      '............',
      '..gggggggg..',
      '...g....g...',
    ],
    alt: [
      '...gggggg...',
      '..gggggggg..',
      '............',
      '..gggggggg..',
      '..ggg..ggg..',
      '..gggg.ggg..',
      '............',
      '..gggggggg..',
      '...g....g...',
    ],
  },
  // Inference familiar: a small green machine, ember antenna, always on.
  chip: {
    palette: { c: '#58c470', r: EMBER },
    rows: [
      '.....rr.....',
      '.....rr.....',
      '...cccccc...',
      '...c.cc.c...',
      '...cccccc...',
      '..c.cccc.c..',
      '..cccccccc..',
      '....c..c....',
      '...cc..cc...',
    ],
    alt: [
      '............',
      '.....rr.....',
      '...cccccc...',
      '...c.cc.c...',
      '...cccccc...',
      '..c.cccc.c..',
      '..cccccccc..',
      '....c..c....',
      '..cc....cc..',
    ],
  },
  // The appraising eye: gold sclera, ember iris, a punched pupil.
  score: {
    palette: { o: '#cfc041', r: EMBER },
    rows: [
      '..o......o..',
      '...oooooo...',
      '..oooooooo..',
      '.oooorroooo.',
      '.ooor..rooo.',
      '..oorrrroo..',
      '...oooooo...',
      '..o......o..',
    ],
    alt: [
      '..o......o..',
      '...oooooo...',
      '..oooooooo..',
      '.ooorrooooo.',
      '.oor..roooo.',
      '..orrrrooo..',
      '...oooooo...',
      '..o......o..',
    ],
  },
};
