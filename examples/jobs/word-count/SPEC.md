# Job: word count

Deliver one file, `wordcount.mjs`: an ES module whose default export is a function `count(text)` that returns the number of words in the string `text`. A word is a maximal run of characters that are not whitespace, where whitespace is what the JavaScript regular expression `\s` matches.

The judge accepts the work when all of these hold:

| `text` | `count(text)` |
|---|---|
| `""` | 0 |
| `"   "` | 0 |
| `"one"` | 1 |
| `"two words"` | 2 |
| `"  leading and trailing  "` | 3 |
| `"tabs\tand\nnew lines"` | 4 |
| `"a\u00a0b"` | 2 |
| `"a  b   c"` | 3 |

The module must not read files, open network connections or start processes.

The same cases, for `intent-engine judge --sandbox viper`:

```judge-cases
{
  "cases": [
    {"args": [""], "expected": 0},
    {"args": ["   "], "expected": 0},
    {"args": ["one"], "expected": 1},
    {"args": ["two words"], "expected": 2},
    {"args": ["  leading and trailing  "], "expected": 3},
    {"args": ["tabs\tand\nnew lines"], "expected": 4},
    {"args": ["a\u00a0b"], "expected": 2},
    {"args": ["a  b   c"], "expected": 3}
  ]
}
```
