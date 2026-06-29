import axios from 'axios';

export async function askLLMToCleanHTML(html: string): Promise<string> {
  const response = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: `Vyčisti toto HTML: ${html}` }]
  }, {
    headers: { 'Authorization': `Bearer fake-token` }
  });
  return response.data.choices[0].message.content;
}
