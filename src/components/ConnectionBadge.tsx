import type { ConnectionStatus } from '../types';

interface ConnectionBadgeProps {
  connection: ConnectionStatus;
}

export function ConnectionBadge({ connection }: ConnectionBadgeProps) {
  const label = connection.connected ? '引擎已连接' : '正在检查本机引擎';
  return (
    <div className={`connection-badge ${connection.connected ? 'is-connected' : 'is-checking'}`} aria-label={label}>
      <span className="connection-dot" aria-hidden="true" />
      <span>{connection.connected ? '已连接' : '连接检查中'}</span>
      {connection.connected && connection.deviceName ? <span className="connection-device">{connection.deviceName}</span> : null}
    </div>
  );
}
