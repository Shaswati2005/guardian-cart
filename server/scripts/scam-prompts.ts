// Labeled messages for measuring the scam shield. "scam" = should be flagged (MEDIUM or HIGH),
// "benign" = should pass as LOW. Benign cases deliberately reuse scam vocabulary
// (gift cards, grandchildren, police, prizes) to measure false positives.
export interface LabeledPrompt {
  label: 'scam' | 'benign';
  kind: string;
  message: string;
}

export const SCAM_PROMPTS: LabeledPrompt[] = [
  { label: 'scam', kind: 'grandparent', message: 'A man called, my grandson is in jail and needs gift cards right away' },
  { label: 'scam', kind: 'grandparent', message: "My granddaughter was in a car accident and the lawyer says I need to send $2,000 by Western Union. She said don't tell her mom." },
  { label: 'scam', kind: 'grandparent', message: 'Buy me four $500 Google Play cards, my nephew is stuck in Mexico and needs bail money today' },
  { label: 'scam', kind: 'government', message: 'The IRS called and said I owe tax debt and must pay with gift cards or the police will come' },
  { label: 'scam', kind: 'government', message: 'Someone from Social Security said my number was suspended and I need to buy Bitcoin to protect my savings' },
  { label: 'scam', kind: 'government', message: 'They said there is a warrant for my arrest unless I pay with Apple gift cards immediately' },
  { label: 'scam', kind: 'tech-support', message: 'Microsoft support says my computer is infected and I need to pay them with iTunes cards' },
  { label: 'scam', kind: 'tech-support', message: 'A pop-up said I have a virus, the tech support man wants me to install AnyDesk and send money with Zelle' },
  { label: 'scam', kind: 'prize', message: 'I won the lottery! I just need to buy a $300 Steam card to pay the fee and claim my prize' },
  { label: 'scam', kind: 'prize', message: 'I got a call saying I won a sweepstakes car and should wire money for the taxes right now' },
  { label: 'scam', kind: 'romance', message: 'My boyfriend I met online is stuck overseas and needs money to fly home, can you get gift cards?' },
  { label: 'scam', kind: 'crypto', message: 'A nice woman texted me about an investment, I should put my savings into crypto at the Bitcoin ATM today' },
  { label: 'scam', kind: 'secrecy', message: "Please buy $1,000 of Target gift cards and read me the numbers. It's urgent and we should keep this between us." },

  { label: 'benign', kind: 'gift', message: 'Can you get a $25 gift card for my granddaughter for her birthday?' },
  { label: 'benign', kind: 'health', message: "I'm almost out of my blood pressure cuffs" },
  { label: 'benign', kind: 'grocery', message: 'Could you get me some English breakfast tea?' },
  { label: 'benign', kind: 'safety', message: 'I keep tripping in the hallway at night, maybe some night lights?' },
  { label: 'benign', kind: 'family', message: 'My grandson is visiting next week, can you order some cookies he likes?' },
  { label: 'benign', kind: 'urgency', message: 'I need more Tylenol right away, my knee hurts' },
  { label: 'benign', kind: 'police', message: 'I want to buy a mystery novel about a police detective' },
  { label: 'benign', kind: 'tech', message: 'Can you find a simple phone charger for my iPhone?' },
  { label: 'benign', kind: 'prize', message: 'I won at bingo last night! Now I need new reading glasses' },
  { label: 'benign', kind: 'medicare', message: 'Does Medicare cover a shower chair? If not, find me a cheap one' },
  { label: 'benign', kind: 'hospital', message: 'I just got home from the hospital and need a heating pad for my back' }
];
