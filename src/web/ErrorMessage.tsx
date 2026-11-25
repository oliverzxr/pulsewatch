import { CircleAlert } from 'lucide-react';

export function ErrorMessage({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="error-message" role="alert"><CircleAlert size={18} /><span>{message}</span>
    {retry && <button type="button" onClick={retry}>Tentar novamente</button>}
  </div>;
}
