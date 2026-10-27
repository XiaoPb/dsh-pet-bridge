;/* dsh-pet-bridge 浏览器半侧：设置页「桌宠桥接」分区（settings.section slot）。
 *
 * 契约（对齐 dsh-pet 与官方文档「Web UI Architecture → Client plugins (dual-face)」）：
 *  - package.json：exports["./client"] → 本文件；dsh.client.platform = "web"；
 *  - 宿主把本文件作为 /plugins/@xiaopb/dsh-pet-bridge/client.js 提供给页面；
 *  - 执行本文件只登记工厂，副作用都在 factory 内（惰性 CJS）；
 *  - 运行时可用 react / react/jsx-runtime 与 slots 服务，不引其它外部依赖。
 *
 * 功能：一个开关（自发布随机词句），经 host 半侧的
 * GET/PUT /dsh-pet-bridge-7781/config 读写。PUT 即时生效并持久化到
 * profile 的 cordis.patch.yml（id: pet-bridge 覆盖条目），无需重启引擎。
 */
;(() => {
  const ROUTE = '/dsh-pet-bridge-7781/config'

  function makeFactory() {
    return (require) => {
      const module = { exports: {} }

      let h
      let useState
      let useEffect
      let useCallback
      let useRef
      try {
        const react = require('react')
        useState = react.useState
        useEffect = react.useEffect
        useCallback = react.useCallback
        useRef = react.useRef
        h = require('react/jsx-runtime').jsx
      } catch (e) {
        // react 不可用（理论上不会：平台模块表恒提供）；不注册任何 UI，只告警。
        try {
          console.warn('[dsh-pet-bridge] 设置分区不可用：react 缺失（' + (e && e.message) + '）')
        } catch (_) {
          /* 忽略 */
        }
        module.exports = { name: 'pet-bridge', inject: [], apply() {} }
        return module.exports
      }

      const name = 'pet-bridge'
      const inject = ['slots']

      // ---- 小组件 ----------------------------------------------------

      /** 行容器：左标题+说明，右开关。颜色全走 inherit，适配明暗主题。 */
      const ToggleRow = (props) =>
        h('label', {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '10px 0',
            cursor: props.busy ? 'wait' : 'pointer',
            opacity: props.busy ? 0.6 : 1,
          },
          children: [
            h('span', {
              key: 'text',
              style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
              children: [
                h('span', {
                  key: 'title',
                  style: { fontSize: 14, lineHeight: '20px' },
                  children: '自发布随机词句',
                }),
                h('span', {
                  key: 'hint',
                  style: { fontSize: 12, lineHeight: '17px', opacity: 0.65 },
                  children:
                    '开启后，桌宠工作气泡在无任务详情时随机补充一句词句；关闭则只显示真实任务详情，词句交给桌宠台词库。',
                }),
              ],
            }),
            h('input', {
              key: 'toggle',
              type: 'checkbox',
              checked: props.checked === true,
              disabled: props.disabled === true,
              onChange: (e) => props.onChange(e.target.checked),
              style: { flex: 'none', width: 18, height: 18, accentColor: 'currentColor' },
            }),
          ],
        })

      function makeConfigSection() {
        return function BridgeConfigSection() {
          const [value, setValue] = useState(null) // null = 加载中
          const [busy, setBusy] = useState(false)
          const [note, setNote] = useState(null) // {kind:'error'|'warn', text}
          const aliveRef = useRef(true)
          useEffect(() => {
            aliveRef.current = true
            return () => {
              aliveRef.current = false
            }
          }, [])
          useEffect(() => {
            let controller = null
            try {
              controller = typeof AbortController === 'function' ? new AbortController() : null
            } catch (_) {
              controller = null
            }
            fetch(ROUTE, {
              cache: 'no-store',
              signal: controller ? controller.signal : undefined,
            })
              .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
              .then((d) => {
                if (aliveRef.current) setValue(d && d.selfPublishRandomLines !== false)
              })
              .catch((e) => {
                if (!aliveRef.current) return
                setValue(false)
                setNote({ kind: 'error', text: '读取桥接配置失败：' + (e && e.message ? e.message : String(e)) })
              })
            return () => {
              if (controller) controller.abort()
            }
          }, [])
          const onToggle = useCallback((next) => {
            setBusy(true)
            setNote(null)
            fetch(ROUTE, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ selfPublishRandomLines: next }),
            })
              .then((r) => r.json().catch(() => ({})).then((d) => ({ ok: r.ok, d })))
              .then(({ ok, d }) => {
                if (!aliveRef.current) return
                if (!ok) throw new Error((d && d.error) || 'HTTP 错误')
                setValue(d && d.selfPublishRandomLines !== false)
                if (d && d.persisted === false) {
                  setNote({ kind: 'warn', text: '已即时生效，但写入配置文件失败——引擎重启后会回落到原值。' })
                }
              })
              .catch((e) => {
                if (!aliveRef.current) return
                setNote({ kind: 'error', text: '保存失败：' + (e && e.message ? e.message : String(e)) })
              })
              .finally(() => {
                if (aliveRef.current) setBusy(false)
              })
          }, [])
          return h('div', {
            style: { padding: '4px 0 12px' },
            children: [
              value === null
                ? h('div', { key: 'loading', style: { fontSize: 13, opacity: 0.6 }, children: '正在读取桥接配置…' })
                : h(ToggleRow, {
                    key: 'row',
                    checked: value,
                    busy,
                    disabled: busy,
                    onChange: onToggle,
                  }),
              note
                ? h('div', {
                    key: 'note',
                    role: 'status',
                    style: { fontSize: 12, lineHeight: '17px', marginTop: 4, opacity: note.kind === 'error' ? 0.9 : 0.7 },
                    children: note.text,
                  })
                : null,
            ],
          })
        }
      }

      function apply(ctx) {
        const slots = ctx && ctx.slots
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          try {
            console.warn('[dsh-pet-bridge] 设置分区不可用：slots 服务缺失')
          } catch (_) {
            /* 忽略 */
          }
          return
        }
        const BridgeConfigSection = makeConfigSection()
        // slots.inject 自带生命周期：随宿主声明消失/插件卸载自动摘除，无需 ctx.effect 再包一层
        slots.inject('settings.section', function* () {
          yield slots.register({
            name: 'settings.section',
            id: 'pet-bridge-config',
            order: 31,
            label: () => '桌宠桥接',
            inject: () => ({}),
          }, BridgeConfigSection)
        })
      }

      module.exports = { apply, inject, name }
      return module.exports
    }
  }

  window.__ModuleLoader__.load({
    id: '@xiaopb/dsh-pet-bridge',
    factory: makeFactory(),
  })
})()
