import { spawn } from 'child_process';

export function renderSvgWithGraphviz(dotBinaryPath: string, dotText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(dotBinaryPath, ['-Tsvg']);
    let out = '';
    let err = '';

    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', (e) => reject(e));
    proc.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err || `dot exited with code ${code}`));
    });

    proc.stdin.write(dotText);
    proc.stdin.end();
  });
}
