use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

pub struct Oracle {
    child: Child,
    input: BufWriter<ChildStdin>,
    output: BufReader<ChildStdout>,
}

impl Oracle {
    pub fn start() -> Result<Self, String> {
        let core = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/core");
        let mut child = Command::new("node")
            .args([
                "--experimental-transform-types",
                "--no-warnings",
                "test/differential/oracle.ts",
            ])
            .current_dir(&core)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("node must be on PATH with pnpm install done: {e}"))?;
        let input = child.stdin.take().ok_or("node has no stdin")?;
        let output = child.stdout.take().ok_or("node has no stdout")?;
        Ok(Self {
            child,
            input: BufWriter::new(input),
            output: BufReader::new(output),
        })
    }

    pub fn batch(&mut self, lines: &[String]) -> Result<Vec<String>, String> {
        let Self { input, output, .. } = self;
        std::thread::scope(|scope| {
            let writer = scope.spawn(move || -> std::io::Result<()> {
                for line in lines {
                    input.write_all(line.as_bytes())?;
                    input.write_all(b"\n")?;
                }
                input.flush()
            });
            let mut answers = Vec::with_capacity(lines.len());
            for _ in lines {
                let mut answer = String::new();
                let read = output
                    .read_line(&mut answer)
                    .map_err(|e| format!("reading the TypeScript side failed: {e}"))?;
                if read == 0 {
                    return Err("the TypeScript side exited early".to_string());
                }
                answers.push(answer.trim_end().to_string());
            }
            writer
                .join()
                .map_err(|_| "the writer thread failed".to_string())?
                .map_err(|e| format!("writing to the TypeScript side failed: {e}"))?;
            Ok(answers)
        })
    }

    pub fn ask(&mut self, line: String) -> Result<String, String> {
        self.batch(&[line])?
            .pop()
            .ok_or_else(|| "no answer".to_string())
    }
}

impl Drop for Oracle {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
