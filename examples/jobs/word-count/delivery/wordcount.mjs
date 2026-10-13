export default function count(text) {
  const words = text.match(/\S+/g);
  return words === null ? 0 : words.length;
}
