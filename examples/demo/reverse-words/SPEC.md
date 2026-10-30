# Demo job: reverse words

Deliver one JavaScript module whose default export is a function `reverseWords(text)`. It takes a string `text` and returns its words in reverse order, joined by single spaces. A word is a maximal run of characters that are not whitespace, where whitespace is what the JavaScript regular expression `\s` matches. A text without words gives `""`.

The module must not read files, open network connections or start processes.

The judge runs these cases with `intent-engine judge --sandbox viper` and accepts the work only when every case passes:

```judge-cases
{
  "cases": [
    {"args": [""], "expected": ""},
    {"args": ["   "], "expected": ""},
    {"args": ["one"], "expected": "one"},
    {"args": ["hello world"], "expected": "world hello"},
    {"args": ["  a  b c  "], "expected": "c b a"},
    {"args": ["tabs\tand\nnew lines"], "expected": "lines new and tabs"},
    {"args": ["a\u00a0b"], "expected": "b a"},
    {"args": ["keep, the punctuation!"], "expected": "punctuation! the keep,"},
    {"args": ["x\u3000y\u2028z"], "expected": "z y x"}
  ]
}
```
