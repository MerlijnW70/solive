export const DEMO_SPECS: Readonly<Record<string, string>> = {
  "638375b5fb917437e51237bfcbcf690bdb583eeac4ee2d07bd8e39e9d921ae70": "fizzbuzz",
  a144c0dd3a4fb16f04c95c1f08a397549e5f6ede132e750e63ed155b8e7bfc00: "palindrome",
  "6bb5772addaed972051efd33c77e983d522f0e0b9f8566149099625ec114a6a4": "reverse-words",
};

export function specName(hash: string | null): string | null {
  return hash !== null && Object.hasOwn(DEMO_SPECS, hash) ? (DEMO_SPECS[hash] ?? null) : null;
}
