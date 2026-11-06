// 环形倒计时：remaining/total 比例渲染，剩余时间居中
interface Props {
  remaining: number
  total: number
  size?: number
  dangerBelow?: number // 低于该秒数变红
}

export default function CountdownRing({ remaining, total, size = 180, dangerBelow = 15 }: Props): JSX.Element {
  const clampedRemain = Math.max(0, remaining)
  const ratio = total > 0 ? clampedRemain / total : 0
  const r = size / 2 - 10
  const c = 2 * Math.PI * r
  const mm = Math.floor(clampedRemain / 60)
  const ss = clampedRemain % 60
  const danger = clampedRemain <= dangerBelow && clampedRemain > 0
  const color = clampedRemain === 0 ? '#9ca3af' : danger ? '#dc2626' : '#2563eb'

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="#e5e7eb" strokeWidth={8} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={8}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - ratio)}
          style={{ transition: 'stroke-dashoffset 0.9s linear, stroke 0.3s' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`text-4xl font-bold tabular-nums ${danger ? 'text-red-600' : 'text-gray-800'}`}>
          {mm}:{String(ss).padStart(2, '0')}
        </span>
      </div>
    </div>
  )
}
