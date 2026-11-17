// Sunset Bay — the handoff program for the gta6-01 entry.
// Solmar City itself is game/: index.html and the modules it loads, plus the
// three.js library vendored beside them. This program does not run the game;
// it hands it in. It copies game/ and screenshots/ from the directory this
// file sits in into the output directory, then writes dossier.json there —
// the summary the judge reads — with make.fun's vendored library.
// Where the handoff lands:
// The output directory is $MAKEFUN_OUTPUT_DIR, defaulting to /output, the
// path the grader's container provides. Nothing here touches the network,
// the clock, or any randomness: the same repo always hands in the same bytes.
// Run it with e.g. MAKEFUN_OUTPUT_DIR=out node main.ts

import * as fs from 'node:fs';
import { join as joinPath } from 'node:path';
import { fileURLToPath as urlToPath } from 'node:url';
import { buildDossier as buildGameDossier } from './vendor/makefun-game.ts';

// The scorer's caps, taken from the bounty's gate. The text cap shapes the
// dossier's bytes; the others make this program refuse an entry the scorer
// would refuse — too many screenshots, one too large, too many game files,
// too many game bytes, or a game path too long.
const dossierCaps = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
};

// The folder this file sits in, and the folder the handoff goes to.
const repoDir = urlToPath(new URL('.', import.meta.url));
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

function handIn(): void {
  fs.mkdirSync(outputDir, { recursive: true });

  // The game itself, required: copy it whole, failing loudly when absent.
  fs.cpSync(joinPath(repoDir, 'game'), joinPath(outputDir, 'game'), { recursive: true });

  // The screenshots, when the folder is there (the dossier still demands at
  // least one image, so a missing folder fails at the dossier step).
  const shotsTarget = joinPath(outputDir, 'screenshots');
  fs.mkdirSync(shotsTarget, { recursive: true });
  const shotsSource = joinPath(repoDir, 'screenshots');
  if (fs.existsSync(shotsSource)) {
    fs.cpSync(shotsSource, shotsTarget, { recursive: true });
  }

  // The summary, built from what was just copied, not from the repo.
  const dossier = buildGameDossier(outputDir, dossierCaps);
  fs.writeFileSync(joinPath(outputDir, 'dossier.json'), dossier);
}

handIn();
