(async () => {
  const DB_NAME    = 'cadence';
  const DB_VERSION = 1;
  const STORE      = 'state';
  const STATE_KEY  = 'cadence-state';
  const SENTINEL   = 'seed-deck-tunes';

  // ── Open IndexedDB ──
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });

  // ── Read existing state ──
  const state = await new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(STATE_KEY);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });

  if (!state)               { console.error('No Cadence state found – open the app first.'); return; }
  if (state.decks[SENTINEL]){ console.warn('Seed data already present. Skipping.'); return; }

  const userId = state.currentUserId;
  const now    = Date.now();
  const DAY    = 86_400_000;

  // ── Review history simulation ──
  function pickRating(profile) {
    const r = Math.random();
    if (profile === 'struggling') {
      if (r < 0.30) return 'again';
      if (r < 0.50) return 'hard';
      if (r < 0.85) return 'good';
      return 'easy';
    }
    if (r < 0.05) return 'again';
    if (r < 0.15) return 'hard';
    if (r < 0.75) return 'good';
    return 'easy';
  }

  function advance(ts, interval, rating) {
    if (rating === 'again') return { ts: ts + Math.floor(Math.random() * DAY), interval: 1 };
    if (rating === 'hard')  return { ts: ts + Math.floor(interval * 1.2 * DAY), interval: Math.max(1, interval * 1.2) };
    if (rating === 'good')  return { ts: ts + Math.floor(interval * 2.2 * DAY), interval: interval * 2.2 };
    /* easy */              return { ts: ts + Math.floor(interval * 3.0 * DAY), interval: interval * 3.0 };
  }

  function makeHistory(profile) {
    if (profile === 'new') {
      const count = Math.floor(Math.random() * 3);
      let ts = now - Math.floor(Math.random() * 30) * DAY;
      const h = [];
      for (let i = 0; i < count && ts < now; i++) {
        h.push({ ts, rating: pickRating('learning') });
        ts += Math.floor((1 + Math.random() * 3) * DAY);
      }
      return h;
    }

    const isMature    = profile === 'learning';
    const startOffset = isMature
      ? (300 + Math.random() * 60) * DAY
      : (60  + Math.random() * 270) * DAY;
    const count = isMature
      ? 4 + Math.floor(Math.random() * 11)
      : 6 + Math.floor(Math.random() *  7);

    let ts = now - Math.floor(startOffset);
    let interval = 1;
    const h = [];
    for (let i = 0; i < count; i++) {
      if (ts >= now) break;
      const rating = pickRating(profile);
      h.push({ ts, rating });
      ({ ts, interval } = advance(ts, interval, rating));
    }
    return h;
  }

  const IMPORTANCE_POOL = [1, 1, 1, 1, 1, 1, 1, 10, 10, 10, 10, 10, 100, 100, 100, 1000];
  const PROFILE_POOL    = ['new','new','struggling','struggling','struggling',
                           'learning','learning','learning','learning','learning','learning','learning'];

  const mkCard = (id, name, tags) => ({
    id, name, tags,
    importance: IMPORTANCE_POOL[Math.floor(Math.random() * IMPORTANCE_POOL.length)],
    content: { notes: '', files: [], embeds: [] },
  });

  const mkWork = (cardId) => {
    const profile = PROFILE_POOL[Math.floor(Math.random() * PROFILE_POOL.length)];
    return { userId, cardId, history: makeHistory(profile) };
  };

  // ── Card catalogue ──
  const cardDefs = [
    // ── Irish Music – Tunes ──
    ['seed-c-tune-01', 'The Blarney Pilgrim',          ['irish-music', 'jig',    'G-major']],
    ['seed-c-tune-02', "Cooley's Reel",                ['irish-music', 'reel',   'D-major']],
    ['seed-c-tune-03', 'The Morning Dew',              ['irish-music', 'reel',   'D-major']],
    ['seed-c-tune-04', 'Sí Beag, Sí Mór',             ['irish-music', 'air',    'G-major']],
    ['seed-c-tune-05', 'The Kesh Jig',                 ['irish-music', 'jig',    'G-major']],
    ['seed-c-tune-06', 'Drowsy Maggie',                ['irish-music', 'reel',   'E-dorian']],
    ['seed-c-tune-07', 'The Irish Washerwoman',        ['irish-music', 'jig',    'G-major']],
    ['seed-c-tune-08', 'The Sally Gardens',            ['irish-music', 'air',    'G-major']],
    ['seed-c-tune-09', 'Banish Misfortune',            ['irish-music', 'jig',    'D-mixolydian']],
    ['seed-c-tune-10', "The Connaughtman's Rambles",   ['irish-music', 'jig',    'D-major']],
    ['seed-c-tune-11', 'The Silver Spear',             ['irish-music', 'reel',   'D-major']],
    ['seed-c-tune-12', 'Planxty Irwin',                ['irish-music', 'planxty','D-major']],

    // ── Irish Music – More Tunes ──
    ['seed-c-tune2-01', 'The Butterfly',               ['irish-music', 'slip-jig', 'E-minor']],
    ['seed-c-tune2-02', 'The Swallowtail Jig',         ['irish-music', 'jig',    'E-minor']],
    ['seed-c-tune2-03', 'Rakish Paddy',                ['irish-music', 'reel',   'D-major']],
    ['seed-c-tune2-04', "The Mason's Apron",           ['irish-music', 'reel',   'D-major']],
    ['seed-c-tune2-05', "Father Kelly's",              ['irish-music', 'reel',   'G-major']],
    ['seed-c-tune2-06', 'Paddy on the Turnpike',       ['irish-music', 'reel',   'D-major']],
    ['seed-c-tune2-07', 'The Merry Blacksmith',        ['irish-music', 'reel',   'D-major']],
    ['seed-c-tune2-08', 'The Walls of Liscarroll',     ['irish-music', 'reel',   'A-major']],
    ['seed-c-tune2-09', 'Lark in the Morning',         ['irish-music', 'jig',    'D-major']],
    ['seed-c-tune2-10', 'The Frost is All Over',       ['irish-music', 'jig',    'D-major']],
    ['seed-c-tune2-11', 'The Rolling Wave',            ['irish-music', 'jig',    'D-major']],
    ['seed-c-tune2-12', 'The Flowers of Edinburgh',    ['irish-music', 'reel',   'D-major']],
    ['seed-c-tune2-13', 'The Humours of Tulla',        ['irish-music', 'reel',   'E-dorian']],
    ['seed-c-tune2-14', "Morrison's Jig",              ['irish-music', 'jig',    'E-minor']],
    ['seed-c-tune2-15', 'The Stack of Barley',         ['irish-music', 'reel',   'G-major']],
    ['seed-c-tune2-16', 'Toss the Feathers',           ['irish-music', 'reel',   'D-major']],
    ['seed-c-tune2-17', 'The Reel of Bogie',           ['irish-music', 'reel',   'A-major']],
    ['seed-c-tune2-18', 'The Rambling Pitchfork',      ['irish-music', 'reel',   'D-major']],

    // ── Irish Music – Sessions ──
    ['seed-c-sess-01', "What does 'session' mean in Irish music?", ['irish-music', 'session']],
    ['seed-c-sess-02', 'What tempo is a reel typically played at?', ['irish-music', 'reel', 'tempo']],
    ['seed-c-sess-03', 'What is a set dance?',                      ['irish-music', 'dance']],
    ['seed-c-sess-04', 'How many beats per bar in a jig?',          ['irish-music', 'theory']],
    ['seed-c-sess-05', "What does 'tune in the key of D' mean?",    ['irish-music', 'theory']],
    ['seed-c-sess-06', "What is a 'slow air'?",                     ['irish-music', 'air']],
    ['seed-c-sess-07', 'What is DADGAD tuning?',                    ['irish-music', 'guitar']],
    ['seed-c-sess-08', 'How many parts does a reel typically have?',['irish-music', 'structure']],

    // ── Irish Music – Music Theory ──
    ['seed-c-mth-01', 'What is a time signature?',                    ['theory', 'rhythm']],
    ['seed-c-mth-02', 'What is a mode?',                              ['theory', 'scales']],
    ['seed-c-mth-03', 'What is the Dorian mode?',                     ['theory', 'scales', 'irish-music']],
    ['seed-c-mth-04', 'What is the Mixolydian mode?',                 ['theory', 'scales', 'irish-music']],
    ['seed-c-mth-05', 'What is a triplet ornament in Irish music?',   ['irish-music', 'ornament']],
    ['seed-c-mth-06', 'What is a cut ornament in Irish music?',       ['irish-music', 'ornament']],
    ['seed-c-mth-07', 'What is a roll ornament?',                     ['irish-music', 'ornament']],
    ['seed-c-mth-08', 'What is a cran ornament?',                     ['irish-music', 'ornament', 'uilleann']],
    ['seed-c-mth-09', 'What is the difference between a reel and a hornpipe?', ['irish-music', 'rhythm']],
    ['seed-c-mth-10', 'What is a polka?',                             ['irish-music', 'dance']],
    ['seed-c-mth-11', 'What is a slide?',                             ['irish-music', 'dance']],
    ['seed-c-mth-12', 'What is a strathspey?',                        ['irish-music', 'dance']],

    // ── Sciences – Biology ──
    ['seed-c-bio-01', 'What is the powerhouse of the cell?',         ['biology', 'cell']],
    ['seed-c-bio-02', 'How many chromosomes in a human cell?',       ['biology', 'genetics']],
    ['seed-c-bio-03', 'What is photosynthesis?',                     ['biology', 'plants']],
    ['seed-c-bio-04', 'What is the function of ribosomes?',          ['biology', 'cell']],
    ['seed-c-bio-05', 'What is DNA?',                                ['biology', 'genetics']],
    ['seed-c-bio-06', 'What is osmosis?',                            ['biology', 'cell']],
    ['seed-c-bio-07', 'Name the four nucleotide bases of DNA',       ['biology', 'genetics']],
    ['seed-c-bio-08', 'What is cellular respiration?',               ['biology', 'cell']],
    ['seed-c-bio-09', 'What is the function of white blood cells?',  ['biology', 'anatomy']],
    ['seed-c-bio-10', 'What is mitosis?',                            ['biology', 'genetics']],

    // ── Sciences – Chemistry ──
    ['seed-c-chem-01', 'What is the atomic number of carbon?',              ['chemistry', 'elements']],
    ['seed-c-chem-02', 'What is the chemical formula for water?',           ['chemistry', 'molecules']],
    ['seed-c-chem-03', 'What is a covalent bond?',                          ['chemistry', 'bonds']],
    ['seed-c-chem-04', 'What is the pH of a neutral solution?',             ['chemistry', 'acids']],
    ['seed-c-chem-05', 'What is the most abundant element in the universe?',['chemistry', 'elements']],
    ['seed-c-chem-06', 'What is an isotope?',                               ['chemistry', 'elements']],
    ['seed-c-chem-07', 'What is oxidation?',                                ['chemistry', 'reactions']],
    ['seed-c-chem-08', "What is Avogadro's number?",                        ['chemistry', 'units']],

    // ── Sciences – Physics ──
    ['seed-c-phy-01', "What is Newton's first law of motion?",  ['physics', 'mechanics']],
    ['seed-c-phy-02', 'What is the formula for kinetic energy?',['physics', 'mechanics']],
    ['seed-c-phy-03', 'What is the SI unit of force?',          ['physics', 'units']],
    ['seed-c-phy-04', "What is Ohm's law?",                     ['physics', 'electricity']],
    ['seed-c-phy-05', 'What is the boiling point of water at sea level?', ['physics', 'thermodynamics']],
    ['seed-c-phy-06', 'What is entropy?',                       ['physics', 'thermodynamics']],
    ['seed-c-phy-07', 'What is the Doppler effect?',            ['physics', 'waves']],
    ['seed-c-phy-08', 'What is a photon?',                      ['physics', 'quantum']],
    ['seed-c-phy-09', 'What does E=mc² mean?',                  ['physics', 'relativity']],
    ['seed-c-phy-10', "What is Newton's law of gravitation?",   ['physics', 'mechanics']],
    ['seed-c-phy-11', 'What is the unit of electrical resistance?', ['physics', 'electricity', 'units']],
    ['seed-c-phy-12', 'What is the speed of sound in air?',     ['physics', 'waves']],

    // ── Sciences – Mathematics ──
    ['seed-c-mat-01', 'What is the Pythagorean theorem?',  ['math', 'geometry']],
    ['seed-c-mat-02', 'What is π (pi)?',                   ['math', 'geometry']],
    ['seed-c-mat-03', 'What is a derivative?',             ['math', 'calculus']],
    ['seed-c-mat-04', 'What is an integral?',              ['math', 'calculus']],
    ['seed-c-mat-05', 'What is the Fibonacci sequence?',   ['math', 'sequences']],
    ['seed-c-mat-06', 'What is a prime number?',           ['math', 'number-theory']],
    ['seed-c-mat-07', "What is Euler's number (e)?",       ['math', 'calculus']],
    ['seed-c-mat-08', 'What is a matrix?',                 ['math', 'linear-algebra']],
    ['seed-c-mat-09', 'What is the quadratic formula?',    ['math', 'algebra']],
    ['seed-c-mat-10', 'What is a logarithm?',              ['math', 'algebra']],

    // ── Languages – Gaeilge ──
    ['seed-c-ga-01', "How do you say 'thank you' in Irish?",   ['gaeilge', 'phrases']],
    ['seed-c-ga-02', "How do you say 'welcome' in Irish?",     ['gaeilge', 'phrases']],
    ['seed-c-ga-03', "What does 'craic' mean?",                ['gaeilge', 'culture']],
    ['seed-c-ga-04', "How do you say 'good morning' in Irish?",['gaeilge', 'phrases']],
    ['seed-c-ga-05', "What does 'sláinte' mean?",              ['gaeilge', 'culture']],
    ['seed-c-ga-06', "How do you say 'I love you' in Irish?",  ['gaeilge', 'phrases']],
    ['seed-c-ga-07', "What does 'Éire' mean?",                 ['gaeilge', 'culture']],

    // ── Languages – Spanish ──
    ['seed-c-es-01', "How do you say 'hello' in Spanish?",              ['spanish', 'phrases']],
    ['seed-c-es-02', "How do you say 'thank you' in Spanish?",          ['spanish', 'phrases']],
    ['seed-c-es-03', "How do you say 'where is the bathroom?' in Spanish?", ['spanish', 'phrases']],
    ['seed-c-es-04', "What is the Spanish word for 'book'?",            ['spanish', 'vocabulary']],
    ['seed-c-es-05', "How do you say 'I don't understand' in Spanish?", ['spanish', 'phrases']],
    ['seed-c-es-06', "What is the Spanish word for 'water'?",           ['spanish', 'vocabulary']],
    ['seed-c-es-07', "How do you say 'good evening' in Spanish?",       ['spanish', 'phrases']],
    ['seed-c-es-08', "What is the Spanish word for 'friend'?",          ['spanish', 'vocabulary']],
    ['seed-c-es-09', 'How do you count from 1 to 5 in Spanish?',        ['spanish', 'numbers']],
    ['seed-c-es-10', 'What is the difference between ser and estar?',   ['spanish', 'grammar']],
    ['seed-c-es-11', "How do you say 'I speak a little Spanish'?",      ['spanish', 'phrases']],
    ['seed-c-es-12', "What is the Spanish word for 'please'?",          ['spanish', 'phrases']],

    // ── Languages – Latin ──
    ['seed-c-lat-01', "What does 'et cetera' mean?",  ['latin', 'expressions']],
    ['seed-c-lat-02', "What does 'per se' mean?",     ['latin', 'expressions']],
    ['seed-c-lat-03', "What does 'ad hoc' mean?",     ['latin', 'expressions']],
    ['seed-c-lat-04', "What does 'carpe diem' mean?", ['latin', 'expressions']],
    ['seed-c-lat-05', "What does 'veni, vidi, vici' mean?", ['latin', 'expressions', 'history']],
    ['seed-c-lat-06', "What does 'in vitro' mean?",   ['latin', 'science']],
    ['seed-c-lat-07', "What does 'alma mater' mean?", ['latin', 'expressions']],
    ['seed-c-lat-08', "What does 'pro bono' mean?",   ['latin', 'expressions']],

    // ── History – World History ──
    ['seed-c-wh-01', 'When did the French Revolution begin?',       ['history', 'france']],
    ['seed-c-wh-02', 'Who was the first US President?',             ['history', 'usa']],
    ['seed-c-wh-03', 'What year did the Berlin Wall fall?',         ['history', 'cold-war']],
    ['seed-c-wh-04', 'Who was Napoleon Bonaparte?',                 ['history', 'france']],
    ['seed-c-wh-05', 'What was the Renaissance?',                   ['history', 'culture']],
    ['seed-c-wh-06', 'When did the Western Roman Empire fall?',     ['history', 'rome']],
    ['seed-c-wh-07', 'Who invented the printing press?',            ['history', 'technology']],
    ['seed-c-wh-08', 'What was the Cold War?',                      ['history', 'politics']],
    ['seed-c-wh-09', 'When did World War I begin?',                 ['history', 'war']],
    ['seed-c-wh-10', 'Who was Genghis Khan?',                       ['history', 'asia']],
    ['seed-c-wh-11', 'What was the Black Death?',                   ['history', 'medicine']],
    ['seed-c-wh-12', 'When did humans first land on the Moon?',     ['history', 'science']],
    ['seed-c-wh-13', 'Who was Cleopatra?',                          ['history', 'egypt']],
    ['seed-c-wh-14', 'What was the Magna Carta?',                   ['history', 'law', 'england']],
    ['seed-c-wh-15', 'What was the Industrial Revolution?',         ['history', 'technology']],

    // ── History – Irish History ──
    ['seed-c-ih-01', 'When was the Easter Rising?',          ['irish-history']],
    ['seed-c-ih-02', 'What was the Great Famine?',           ['irish-history']],
    ['seed-c-ih-03', 'When did Ireland gain independence?',  ['irish-history']],
    ['seed-c-ih-04', 'Who was Michael Collins?',             ['irish-history']],
    ['seed-c-ih-05', 'What was the Battle of the Boyne?',    ['irish-history']],
    ['seed-c-ih-06', 'What role did the Vikings play in Ireland?', ['irish-history']],
    ['seed-c-ih-07', 'What is the Book of Kells?',           ['irish-history', 'culture']],
    ['seed-c-ih-08', 'When was the Act of Union?',           ['irish-history', 'politics']],
    ['seed-c-ih-09', 'Who was Wolfe Tone?',                  ['irish-history']],
    ['seed-c-ih-10', 'What was the Land League?',            ['irish-history']],

    // ── History – Literature ──
    ['seed-c-lit-01', "Who wrote 'Don Quixote'?",                  ['literature', 'spanish']],
    ['seed-c-lit-02', "Who wrote 'Crime and Punishment'?",         ['literature', 'russian']],
    ['seed-c-lit-03', "Who wrote 'One Hundred Years of Solitude'?",['literature', 'spanish']],
    ['seed-c-lit-04', "Who wrote 'The Divine Comedy'?",            ['literature', 'italian']],
    ['seed-c-lit-05', "Who wrote 'Hamlet'?",                       ['literature', 'english']],
    ['seed-c-lit-06', "Who wrote 'In Search of Lost Time'?",       ['literature', 'french']],
    ['seed-c-lit-07', "Who wrote 'The Metamorphosis'?",            ['literature', 'german']],
    ['seed-c-lit-08', "Who wrote 'War and Peace'?",                ['literature', 'russian']],
    ['seed-c-lit-09', "Who wrote 'The Catcher in the Rye'?",       ['literature', 'american']],
    ['seed-c-lit-10', "Who wrote 'Waiting for Godot'?",            ['literature', 'irish']],
    ['seed-c-lit-11', "Who wrote 'Dracula'?",                      ['literature', 'irish']],
    ['seed-c-lit-12', "Who wrote 'Frankenstein'?",                 ['literature', 'english']],

    // ── Arts – Art History ──
    ['seed-c-art-01', 'Who painted the Sistine Chapel ceiling?',  ['art', 'renaissance']],
    ['seed-c-art-02', 'What is Impressionism?',                   ['art', 'movement']],
    ['seed-c-art-03', 'Who was Salvador Dalí?',                   ['art', 'surrealism']],
    ['seed-c-art-04', 'What is the Venus de Milo?',               ['art', 'sculpture', 'ancient']],
    ['seed-c-art-05', 'Who painted Starry Night?',                ['art', 'post-impressionism']],
    ['seed-c-art-06', 'What is Cubism?',                          ['art', 'movement']],
    ['seed-c-art-07', 'Who was Rembrandt?',                       ['art', 'baroque']],
    ['seed-c-art-08', 'What is the Baroque period?',              ['art', 'history']],
    ['seed-c-art-09', 'Who sculpted The Thinker?',                ['art', 'sculpture']],
    ['seed-c-art-10', 'What is Abstract Expressionism?',          ['art', 'movement']],

    // ── Arts – Classical Music ──
    ['seed-c-cla-01', 'Who composed the Fifth Symphony?',       ['classical-music', 'composer']],
    ['seed-c-cla-02', 'Who was Johann Sebastian Bach?',         ['classical-music', 'composer']],
    ['seed-c-cla-03', 'What is a sonata?',                      ['classical-music', 'form']],
    ['seed-c-cla-04', 'What is a symphony?',                    ['classical-music', 'form']],
    ['seed-c-cla-05', 'Who composed The Four Seasons?',         ['classical-music', 'composer']],
    ['seed-c-cla-06', 'What is an opera?',                      ['classical-music', 'form']],
    ['seed-c-cla-07', 'Who was Wolfgang Amadeus Mozart?',       ['classical-music', 'composer']],
    ['seed-c-cla-08', 'What is a concerto?',                    ['classical-music', 'form']],
    ['seed-c-cla-09', 'Who composed The Rite of Spring?',       ['classical-music', 'composer']],
    ['seed-c-cla-10', 'What is counterpoint?',                  ['classical-music', 'theory']],

    // ── General Knowledge ──
    ['seed-c-gen-01', 'What is the capital of Ireland?',          ['geography', 'ireland']],
    ['seed-c-gen-02', 'Who painted the Mona Lisa?',               ['art', 'history']],
    ['seed-c-gen-03', 'What year did World War II end?',          ['history']],
    ['seed-c-gen-04', 'What is the speed of light?',              ['physics']],
    ['seed-c-gen-05', "Who wrote 'Ulysses'?",                     ['literature', 'ireland']],
    ['seed-c-gen-06', 'What is the longest river in Ireland?',    ['geography', 'ireland']],
    ['seed-c-gen-07', 'What is the highest mountain in Ireland?', ['geography', 'ireland']],
    ['seed-c-gen-08', 'What is the Turing Test?',                 ['computer-science']],
    ['seed-c-gen-09', 'How many planets are in the solar system?',['astronomy']],
    ['seed-c-gen-10', 'What is the tallest mountain in the world?',['geography']],
    ['seed-c-gen-11', 'What is the largest ocean on Earth?',      ['geography']],
    ['seed-c-gen-12', 'Who was Albert Einstein?',                 ['history', 'science']],
    ['seed-c-gen-13', 'What is the Higgs boson?',                 ['physics', 'quantum']],
    ['seed-c-gen-14', 'What is democracy?',                       ['politics']],
    ['seed-c-gen-15', 'What is the GDP of a country?',            ['economics']],
    ['seed-c-gen-16', 'What is carbon dating?',                   ['science', 'archaeology']],
  ];

  // ── Build cards & works ──
  const newCards = {}, newWorks = {};
  for (const [id, name, tags] of cardDefs) {
    newCards[id]                = mkCard(id, name, tags);
    newWorks[`${userId}:${id}`] = mkWork(id);
  }

  // ── Build decks ──
  const ids = prefix => cardDefs.filter(([id]) => id.startsWith(prefix)).map(([id]) => id);
  const mkDeck = (id, name, cardIds) => ({ id, name, entries: cardIds.map(cardId => ({ cardId })) });

  const newDecks = {
    'seed-deck-tunes':         mkDeck('seed-deck-tunes',         'Tunes',             ids('seed-c-tune-')),
    'seed-deck-tunes2':        mkDeck('seed-deck-tunes2',        'More Tunes',        ids('seed-c-tune2-')),
    'seed-deck-sessions':      mkDeck('seed-deck-sessions',      'Sessions',          ids('seed-c-sess-')),
    'seed-deck-music-theory':  mkDeck('seed-deck-music-theory',  'Music Theory',      ids('seed-c-mth-')),
    'seed-deck-biology':       mkDeck('seed-deck-biology',       'Biology',           ids('seed-c-bio-')),
    'seed-deck-chemistry':     mkDeck('seed-deck-chemistry',     'Chemistry',         ids('seed-c-chem-')),
    'seed-deck-physics':       mkDeck('seed-deck-physics',       'Physics',           ids('seed-c-phy-')),
    'seed-deck-math':          mkDeck('seed-deck-math',          'Mathematics',       ids('seed-c-mat-')),
    'seed-deck-gaeilge':       mkDeck('seed-deck-gaeilge',       'Gaeilge',           ids('seed-c-ga-')),
    'seed-deck-spanish':       mkDeck('seed-deck-spanish',       'Spanish',           ids('seed-c-es-')),
    'seed-deck-latin':         mkDeck('seed-deck-latin',         'Latin',             ids('seed-c-lat-')),
    'seed-deck-world-history': mkDeck('seed-deck-world-history', 'World History',     ids('seed-c-wh-')),
    'seed-deck-irish-history': mkDeck('seed-deck-irish-history', 'Irish History',     ids('seed-c-ih-')),
    'seed-deck-literature':    mkDeck('seed-deck-literature',    'Literature',        ids('seed-c-lit-')),
    'seed-deck-art-history':   mkDeck('seed-deck-art-history',   'Art History',       ids('seed-c-art-')),
    'seed-deck-classical':     mkDeck('seed-deck-classical',     'Classical Music',   ids('seed-c-cla-')),
    'seed-deck-general':       mkDeck('seed-deck-general',       'General Knowledge', ids('seed-c-gen-')),
  };

  // ── Build folders ──
  const mkFolder = (id, name, deckIds) => ({ userId, id, name, folderIds: [], deckIds });

  const newFolders = {
    'seed-folder-irish':    mkFolder('seed-folder-irish',    'Irish Music',
      ['seed-deck-tunes', 'seed-deck-tunes2', 'seed-deck-sessions', 'seed-deck-music-theory']),
    'seed-folder-sciences': mkFolder('seed-folder-sciences', 'Sciences',
      ['seed-deck-biology', 'seed-deck-chemistry', 'seed-deck-physics', 'seed-deck-math']),
    'seed-folder-languages':mkFolder('seed-folder-languages','Languages',
      ['seed-deck-gaeilge', 'seed-deck-spanish', 'seed-deck-latin']),
    'seed-folder-history':  mkFolder('seed-folder-history',  'History & Literature',
      ['seed-deck-world-history', 'seed-deck-irish-history', 'seed-deck-literature']),
    'seed-folder-arts':     mkFolder('seed-folder-arts',     'Arts & Music',
      ['seed-deck-art-history', 'seed-deck-classical']),
  };

  // ── Merge & save ──
  const newState = {
    ...state,
    cards:        { ...state.cards,     ...newCards   },
    decks:        { ...state.decks,     ...newDecks   },
    cardWorks:    { ...state.cardWorks, ...newWorks   },
    folders:      { ...state.folders,   ...newFolders },
    rootFolderIds: [
      ...(state.rootFolderIds ?? []),
      'seed-folder-irish', 'seed-folder-sciences', 'seed-folder-languages',
      'seed-folder-history', 'seed-folder-arts',
    ],
    rootDeckIds: [...(state.rootDeckIds ?? []), 'seed-deck-general'],
  };

  await new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).put(newState, STATE_KEY);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });

  const totalReviews = Object.values(newWorks).reduce((s, w) => s + w.history.length, 0);
  console.log(`✅ Seed done: ${cardDefs.length} cards · ${Object.keys(newDecks).length} decks · ${Object.keys(newFolders).length} folders · ${totalReviews} reviews total. Reload the page.`);
})();
