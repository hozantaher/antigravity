import fs from 'fs';
import path from 'path';

const diaryPath = path.join(process.cwd(), '.vektor', 'diary', 'diary.md');
const changelogPath = path.join(process.cwd(), 'CHANGELOG.md');

if (!fs.existsSync(diaryPath)) {
  console.log('Žádný deník nebyl nalezen.');
  process.exit(0);
}

const content = fs.readFileSync(diaryPath, 'utf8');
const lines = content.split('\n');

let changelog = '# CHANGELOG\n\nAutomaticky vygenerováno z Antigravity deníku.\n\n';
const currentEntry = '';

for (const line of lines) {
  if (line.startsWith('## [')) {
    const match = line.match(/## \[([^\]]+)\] (.*)/);
    if (match) {
      const date = new Date(match[1]).toISOString().split('T')[0];
      const action = match[2];
      changelog += `### ${date} - ${action}\n`;
    }
  } else if (line.startsWith('- **Details:**')) {
    changelog += `${line.replace('- **Details:**', '- ')}\n\n`;
  }
}

fs.writeFileSync(changelogPath, changelog, 'utf8');
console.log('CHANGELOG.md byl úspěšně vygenerován.');
