import { motion, useReducedMotion } from 'motion/react'

import { cn } from '@/lib/utils'

type TextGenerateEffectProps = {
  words: string
  className?: string
  duration?: number
  filter?: boolean
}

const segmentText = (value: string) => value.includes(' ') ? value.split(/(\s+)/) : Array.from(value)

export const TextGenerateEffect = ({
  words,
  className,
  duration = 0.32,
  filter = true,
}: TextGenerateEffectProps) => {
  const prefersReducedMotion = useReducedMotion()

  return (
    <span className={cn('text-generate-effect', className)}>
      <span className="sr-only">{words}</span>
      <span aria-hidden="true">
        {segmentText(words).map((segment, index) => (
          <motion.span
            className="text-generate-effect-segment aceternity-motion-safe"
            initial={prefersReducedMotion ? false : { opacity: 0, filter: filter ? 'blur(8px)' : 'none' }}
            animate={{ opacity: 1, filter: 'blur(0px)' }}
            transition={{ duration: prefersReducedMotion ? 0 : duration, delay: prefersReducedMotion ? 0 : index * 0.065 }}
            key={`${segment}-${index}`}
          >
            {segment}
          </motion.span>
        ))}
      </span>
    </span>
  )
}
