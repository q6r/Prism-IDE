// Custom SSH / remote icon (inherits currentColor like the lucide set).
export default function SshIcon({ size = 21, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M10.495 8.3h.01" />
      <path d="M13.58 8.32h3.68" />
      <path d="M16.73 2c.65 0 1.23.02 1.75.09C21.25 2.4 22 3.7 22 7.26v6.32c0 3.56-.75 4.86-3.52 5.17-.52.07-1.09.09-1.75.09H7.26c-.65 0-1.23-.02-1.75-.09-2.77-.31-3.52-1.61-3.52-5.17V7.26c0-3.56.75-4.86 3.52-5.17.52-.07 1.1-.09 1.75-.09z" />
      <path d="M6.74 14.11h10.53" />
      <path d="M7 22h10" />
      <path d="M7.195 8.3h.01" />
    </svg>
  )
}
