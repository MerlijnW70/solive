# Demo job: palindrome

Deliver one JavaScript module whose default export is a function `isPalindrome(text)`. It takes a string `text` and returns `true` when `text` reads the same forwards and backwards, and `false` otherwise.

Before comparing, drop every character that is not an ASCII letter or digit (`A` to `Z`, `a` to `z`, `0` to `9`) and treat upper and lower case ASCII letters as the same. A text with nothing left is a palindrome.

The module must not read files, open network connections or start processes.

The judge runs these cases with `intent-engine judge --sandbox viper` and accepts the work only when every case passes:

```judge-cases
{
  "cases": [
    {"args": [""], "expected": true},
    {"args": ["a"], "expected": true},
    {"args": ["ab"], "expected": false},
    {"args": ["Racecar"], "expected": true},
    {"args": ["hello"], "expected": false},
    {"args": ["A man, a plan, a canal: Panama!"], "expected": true},
    {"args": ["Was it a car or a cat I saw?"], "expected": true},
    {"args": ["No 'x' in Nixon"], "expected": true},
    {"args": ["12321"], "expected": true},
    {"args": ["123"], "expected": false},
    {"args": ["?!. ,"], "expected": true},
    {"args": ["ab\u00e9ba"], "expected": true},
    {"args": ["x\u0130"], "expected": true},
    {"args": ["x\u212a"], "expected": true}
  ]
}
```
