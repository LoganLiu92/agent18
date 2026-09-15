import { diagnose } from './lib/doctor.js';
import { localDirectory } from './config.js';
try {
  const report = await diagnose(localDirectory);
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('agent18 · 运行诊断\n');
    for (const c of report.checks)
      console.log(
        `${c.status === 'pass' ? '✓' : c.status === 'warn' ? '!' : '×'} ${c.title} — ${c.detail}${c.status === 'fail' && c.fix ? '\n  ' + c.fix : ''}`,
      );
  }
  if (!report.ready || (process.argv.includes('--strict') && report.checks.some((c) => c.status === 'warn')))
    process.exitCode = 1;
} catch {
  console.error('诊断无法读取部署配置。请先运行 pnpm run setup，并检查 AGENT18_LOCAL_DIR。');
  process.exitCode = 1;
}
