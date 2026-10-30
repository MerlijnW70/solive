export default function reverseWords(text) {
  const words = text.match(/\S+/g);
  return words === null ? "" : words.reverse().join(" ");
}
