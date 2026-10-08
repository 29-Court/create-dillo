import { Armadillo } from 'create-dillo/client';
import type backend from '../backend.ts';
const client = Armadillo.client<typeof backend>({ appId: 'minimal' });
const output = document.querySelector<HTMLElement>('#projects')!;
const status = document.querySelector<HTMLElement>('#status')!;
const form = document.querySelector<HTMLFormElement>('form')!;
const logout = document.querySelector<HTMLButtonElement>('#logout')!;
async function render() {
    const user = await client.auth.currentUser();
    form.hidden = !user;
    logout.hidden = !user;
    if (!user) {
        status.textContent = 'Open the one-use sign-in link printed in your terminal.';
        output.replaceChildren();
        return;
    }
    status.textContent = (await client.functions.greet({ name: user.name || 'neighbor' })).message;
    output.replaceChildren();
    const projects = await client.tables.Project.query().find();
    if (projects.length === 0) {
        const empty = document.createElement('li');
        empty.textContent = 'Nothing here yet. Add the first plan.';
        output.append(empty);
    }
    for (const project of projects) {
        const row = document.createElement('li');
        const toggle = document.createElement('button');
        toggle.textContent = (project.active ? '○ ' : '✓ ') + project.name;
        toggle.onclick = () => perform(async () => { await client.tables.Project.update(project.id, { active: !project.active }); });
        const remove = document.createElement('button');
        remove.textContent = 'Delete';
        remove.onclick = () => perform(async () => { await client.tables.Project.delete(project.id); });
        row.append(toggle, remove);
        output.append(row);
    }
}
async function perform(action: () => Promise<void>) { try {
    await action();
    await render();
}
catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
} }
form.onsubmit = event => { event.preventDefault(); void perform(async () => { const input = form.elements.namedItem('name') as HTMLInputElement; await client.tables.Project.create({ name: input.value, active: true }); form.reset(); }); };
document.querySelector<HTMLButtonElement>('#logout')!.onclick = () => perform(async () => { await client.auth.logOut(); });
void perform(async () => { const url = new URL(location.href); const token = url.searchParams.get('armadillo_magic_token'); if (token) {
    history.replaceState({}, '', '/');
    await client.auth.verifyMagicLink(token);
} });
