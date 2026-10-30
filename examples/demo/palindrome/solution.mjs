export default function isPalindrome(text) {
  const kept = text.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return kept === kept.split("").reverse().join("");
}
