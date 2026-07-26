import { DotBackground } from '@/components/ui/dot-background'
import { TextGenerateEffect } from '@/components/ui/text-generate-effect'

type LandingWelcomeProps = {
  projectName?: string
}

export const LandingWelcome = ({ projectName }: LandingWelcomeProps) => (
  <section className="welcome-state" aria-label="空白任务">
    <DotBackground className="landing-welcome-surface">
      <div className="welcome-content">
        <div className="empty-composer-brand" aria-hidden="true">
          <img src="/grok-build-icon-v5.png" alt="" />
          <span className="empty-composer-brand-name">RunBuild</span>
        </div>
        <TextGenerateEffect words={projectName ? `今天要在“${projectName}”中构建什么？` : '今天要构建什么？'} className="landing-welcome-prompt" />
      </div>
    </DotBackground>
  </section>
)
