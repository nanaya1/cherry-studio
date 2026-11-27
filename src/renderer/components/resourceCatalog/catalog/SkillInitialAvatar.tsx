const palette = [
  { backgroundColor: '#eaf6ed', color: '#39734b' },
  { backgroundColor: '#eaf1fa', color: '#496c94' },
  { backgroundColor: '#fff2df', color: '#936324' },
  { backgroundColor: '#f3edf8', color: '#76578b' },
  { backgroundColor: '#edf3f4', color: '#526a70' }
]

export function SkillInitialAvatar({ name, index }: { name: string; index: number }) {
  return (
    <span
      aria-hidden
      className="grid size-9 shrink-0 place-items-center rounded-full font-semibold text-sm"
      style={palette[index % palette.length]}>
      {Array.from(name)[0]}
    </span>
  )
}
