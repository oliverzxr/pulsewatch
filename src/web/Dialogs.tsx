import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import type { FormEvent, ReactNode } from 'react';
import type { Monitor } from '../shared/contracts.ts';
import { request } from './api.ts';
import { ErrorMessage } from './ErrorMessage.tsx';

function Modal({ title, description, icon, children, onClose }: {
  title: string; description: string; icon: ReactNode; children: ReactNode; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
    return () => {
      if (dialog.open) dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  return <dialog ref={ref} className="modal" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <button type="button" className="icon-button close-modal" aria-label="Fechar" onClick={onClose}><X size={20} /></button>
    <div className="modal-heading"><span className="modal-icon">{icon}</span>
      <h2 id={titleId}>{title}</h2><p id={descriptionId}>{description}</p>
    </div>
    {children}
  </dialog>;
}

export function CreateMonitor({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setSaving(true);
    setError('');
    try {
      await request<Monitor>('/monitors', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: data.get('name'), url: data.get('url') }),
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return <Modal title="Adicionar monitor" description="Informe o endereço público do site ou da API." icon={<Plus size={22} />}
    onClose={() => { if (!saving) onClose(); }}>
    <form onSubmit={submit} className="monitor-form">
      <label>Nome do monitor<input name="name" required maxLength={80} placeholder="Ex.: Site institucional" data-initial-focus /></label>
      <label>URL<input name="url" required type="url" maxLength={2048} placeholder="https://example.org" /></label>
      {error && <ErrorMessage message={error} />}
      <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose} disabled={saving}>Cancelar</button>
        <button type="submit" className="button primary" disabled={saving}>{saving ? 'Adicionando…' : 'Adicionar monitor'}</button></div>
    </form>
  </Modal>;
}

export function RemoveMonitor({ monitor, onClose, onRemoved }: { monitor: Monitor; onClose: () => void; onRemoved: () => void }) {
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(false);

  async function remove() {
    setRemoving(true);
    setError('');
    try {
      await request(`/monitors/${monitor.id}`, { method: 'DELETE' });
      onRemoved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRemoving(false);
    }
  }

  return <Modal title="Remover monitor" description={`O monitor “${monitor.name}” e todo o seu histórico serão excluídos.`}
    icon={<Trash2 size={20} />} onClose={() => { if (!removing) onClose(); }}>
    {error && <ErrorMessage message={error} />}
    <div className="modal-actions"><button type="button" className="button secondary" data-initial-focus onClick={onClose} disabled={removing}>Cancelar</button>
      <button type="button" className="button danger" onClick={() => void remove()} disabled={removing}>{removing ? 'Removendo…' : 'Remover monitor'}</button></div>
  </Modal>;
}
