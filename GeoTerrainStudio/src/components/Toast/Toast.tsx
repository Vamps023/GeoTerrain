import React, { useEffect } from 'react';
import { useTerrainStore } from '../../core/store';
import { CheckCircle, AlertCircle, Info, X } from 'lucide-react';

export const ToastContainer: React.FC = () => {
  const notifications = useTerrainStore((s) => s.notifications);
  const removeNotification = useTerrainStore((s) => s.removeNotification);

  return (
    <div className="fixed top-16 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {notifications.map((n) => (
        <Toast
          key={n.id}
          notification={n}
          onClose={() => removeNotification(n.id)}
        />
      ))}
    </div>
  );
};

interface ToastProps {
  notification: { id: string; type: 'success' | 'error' | 'info'; message: string };
  onClose: () => void;
}

const Toast: React.FC<ToastProps> = ({ notification, onClose }) => {
  useEffect(() => {
    const timer = setTimeout(onClose, 4000);
    return () => clearTimeout(timer);
  }, [onClose]);

  const isSuccess = notification.type === 'success';
  const isError = notification.type === 'error';

  return (
    <div className="pointer-events-auto min-w-[280px] max-w-[400px] bg-[#0f1a10] border border-[#4a7c3f]/60 rounded-lg shadow-xl p-3 flex items-start gap-3 animate-in slide-in-from-right">
      <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
        isSuccess ? 'bg-[#4a7c3f]/30 border border-[#4a7c3f]/60' :
        isError ? 'bg-red-500/20 border border-red-500/40' :
        'bg-[#c4a96b]/20 border border-[#c4a96b]/40'
      }`}>
        {isSuccess ? (
          <CheckCircle className="w-4 h-4 text-[#7ab86f]" />
        ) : isError ? (
          <AlertCircle className="w-4 h-4 text-red-400" />
        ) : (
          <Info className="w-4 h-4 text-[#c4a96b]" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-sm ${isError ? 'text-red-300' : 'text-gray-200'} leading-snug`}>
          {notification.message}
        </p>
      </div>
      <button
        onClick={onClose}
        className="text-gray-500 hover:text-[#c4a96b] transition-colors shrink-0"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
};
