/* Wonder Meadow — the opener's words.
 * Edit freely; no other file needs to change. (After editing, bump the ?v= number in
 * index.html so returning visitors don't get a cached copy.)
 *
 * sections : shown in this order, then loop back to the first forever
 *   text   : short and big — use \n to break lines yourself
 *   tone   : 'light' = white words on the deep purple
 *            'dark'  = black words; the background warms up into a soft lilac glow behind them
 *
 * PLACEHOLDER WORDING — replace with your own.
 */
export default {
  sections: [
    { text: 'Some questions\nare too heavy\nto carry alone.', tone: 'light' },
    { text: 'Whisper yours\nto the meadow.', tone: 'dark' },
    { text: 'A stranger\nwill answer.', tone: 'light' },
  ],
  brand: 'Wonder Meadow',
  hint: 'Scroll to drift',
  enterLabel: 'Enter the meadow',
};
