interface PromptComposerProps {
  value: string;
  onChange: (value: string) => void;
}

const EXAMPLE_PROMPT = '一杯咖啡的热气缓缓升起，镜头缓慢推近，背景虚化。柔和晨光，真实电影感；伴随安静的室内环境声与轻微蒸汽声。';

export function PromptComposer({ value, onChange }: PromptComposerProps) {
  return (
    <section className="field-group prompt-group">
      <div className="field-heading">
        <label htmlFor="prompt">创作描述 <span>Prompt</span></label>
        <span className="character-count">{value.length} / 4000</span>
      </div>
      <div className="prompt-surface">
        <textarea
          id="prompt"
          value={value}
          maxLength={4000}
          onChange={(event) => onChange(event.target.value)}
          placeholder="描述场景、主体、镜头运动、光线与声音……"
          rows={6}
        />
        {!value && (
          <button className="prompt-example" type="button" onClick={() => onChange(EXAMPLE_PROMPT)}>
            <span className="sparkle" aria-hidden="true">✦</span>
            使用示例灵感
          </button>
        )}
      </div>
      <p className="field-hint">可在同一段描述中写入画面、镜头语言和希望听到的环境声。</p>
    </section>
  );
}
