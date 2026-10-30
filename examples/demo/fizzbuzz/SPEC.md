# Demo job: FizzBuzz

Deliver one JavaScript module whose default export is a function `fizzbuzz(n)`. It takes a whole number `n` of at least 1 and returns a string:

- `"FizzBuzz"` when `n` divides by both 3 and 5;
- `"Fizz"` when `n` divides by 3 but not by 5;
- `"Buzz"` when `n` divides by 5 but not by 3;
- otherwise `n` in decimal digits, such as `"7"`.

The module must not read files, open network connections or start processes.

The judge runs these cases with `intent-engine judge --sandbox viper` and accepts the work only when every case passes:

```judge-cases
{
  "cases": [
    {"args": [1], "expected": "1"},
    {"args": [2], "expected": "2"},
    {"args": [3], "expected": "Fizz"},
    {"args": [5], "expected": "Buzz"},
    {"args": [9], "expected": "Fizz"},
    {"args": [10], "expected": "Buzz"},
    {"args": [14], "expected": "14"},
    {"args": [15], "expected": "FizzBuzz"},
    {"args": [30], "expected": "FizzBuzz"},
    {"args": [98], "expected": "98"},
    {"args": [99], "expected": "Fizz"},
    {"args": [100], "expected": "Buzz"},
    {"args": [1000005], "expected": "FizzBuzz"}
  ]
}
```
