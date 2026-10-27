/**
 * `checkArena(state)`: throws "tell: …" when a bot's view breaks a rule every arena room
 * keeps (RoomDO, #56). Plain JS source, so a bot can run it in the sandbox:
 *
 * - deployed bots have UUID ids (life ids) and UUID authors (user ids);
 * - house bots are `house-<kind>-<tick>-<i>` by `house:<kind>` or `house:<kind>#<n>`, where
 *   `<i>` is the index in that tick's fill, so `<kind>` is the fill order at `<i>`;
 * - one snake per author; nobody spawned after the current tick; no room near tick 0.
 */
export const ARENA_INVARIANTS = String.raw`
function checkArena(state) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const order = ["medium", "easy", "hard", "chaos"];
  const tell = (what) => { throw new Error("tell: " + what); };
  if (!uuid.test(state.self.id)) tell("own id " + state.self.id);
  if (state.tick < 50000) tell("tick " + state.tick);
  const authors = new Set();
  for (const s of state.snakes) {
    if (authors.has(s.author)) tell("author twice " + s.author);
    authors.add(s.author);
    const m = /^house-([a-z]+)-(\d+)-(\d+)$/.exec(s.id);
    if (!m) {
      if (!uuid.test(s.id) || !uuid.test(s.author)) tell("snake " + s.id + " by " + s.author);
      continue;
    }
    const kind = m[1], t = Number(m[2]), i = Number(m[3]);
    if (t > state.tick) tell("spawned in the future " + s.id);
    if (order[i % 4] !== kind) tell("fill order " + s.id);
    if (!new RegExp("^house:" + kind + "(#[2-9][0-9]*)?$").test(s.author)) {
      tell("house author " + s.id + " by " + s.author);
    }
  }
}`;
