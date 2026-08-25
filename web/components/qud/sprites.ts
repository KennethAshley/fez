/**
 * The roster's pixel sprites, drawn as character maps — the Caves of Qud
 * grammar (a tiny creature on a dark ground, three or four colors, a
 * little asymmetry for charm) worn by fez's agents. Each char indexes
 * the sprite's own palette; '.' is transparent. Editing a sprite is
 * editing text, which is the point: the art stays reviewable in a diff.
 */

export interface Sprite {
  rows: string[];
  palette: Record<string, string>;
}

const BONE = '#e8e2d9';
const DUST = '#6d645a';
const EMBER = '#FF6A00';
const GOLD = '#cfc041';
const INK = '#141210';

export const SPRITES: Record<string, Sprite> = {
  // The guide wears the hat the network is named for.
  fez: {
    palette: { r: EMBER, y: GOLD, f: BONE, e: INK, d: DUST },
    rows: [
      '....rrrr....',
      '....rrrr.y..',
      '...ffffff.y.',
      '...feffef...',
      '...ffffff...',
      '..dddddddd..',
      '..dddddddd..',
      '..ddrrrrdd..',
      '..dddddddd..',
      '...dd..dd...',
      '...dd..dd...',
    ],
  },
  // Subnet cartographer: wide-brim hat, spyglass to the eye.
  scout: {
    palette: { t: '#6fb3b8', h: '#3c7f84', f: BONE, e: INK, g: '#9aa0a6', d: DUST },
    rows: [
      '..hhhhhhhh..',
      '....tttt....',
      '....ffff....',
      '....feffgggg',
      '....ffff.g..',
      '...tttttt...',
      '...tttttt...',
      '...tttttt...',
      '....t..t....',
      '....t..t....',
    ],
  },
  // The weaver is its loom: two posts, warp threads, a gold shuttle.
  loom: {
    palette: { v: '#9d6fcf', m: '#c64ead', y: GOLD },
    rows: [
      '..v......v..',
      '..vvvvvvvv..',
      '..v.m.m..v..',
      '..v.m.m.mv..',
      '..vyyyyyyv..',
      '..vm..m..v..',
      '..vm.mm.mv..',
      '..vvvvvvvv..',
      '..v......v..',
    ],
  },
  // Keeper of the deep: a strongbox with a keyhole.
  vault: {
    palette: { g: GOLD, k: '#4a3f1e', e: INK, d: DUST },
    rows: [
      '...gggggg...',
      '..gggggggg..',
      '..kkkkkkkk..',
      '..gggggggg..',
      '..gggeeggg..',
      '..ggggeggg..',
      '..kkkkkkkk..',
      '..gggggggg..',
      '...d....d...',
    ],
  },
  // Inference familiar: a small green machine, always listening.
  chip: {
    palette: { c: '#58c470', a: '#2e7d44', e: INK, p: DUST },
    rows: [
      '.....aa.....',
      '.....aa.....',
      '...cccccc...',
      '...ceccec...',
      '...cccccc...',
      '..p.cccc.p..',
      '..pccccccp..',
      '....c..c....',
      '...pp..pp...',
    ],
  },
  // The appraising eye: it will not praise what it cannot measure.
  score: {
    palette: { o: GOLD, i: EMBER, e: INK, d: DUST },
    rows: [
      '..d......d..',
      '...oooooo...',
      '..oooooooo..',
      '.ooooiioooo.',
      '.oooiieiioo.',
      '..ooiiiioo..',
      '...oooooo...',
      '..d......d..',
    ],
  },
};
