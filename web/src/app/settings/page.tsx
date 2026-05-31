'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { PageHeader } from '@/components/ui'
import { IconCheck, IconClock } from '@/components/icons'

type Tab = 'perfil' | 'conexao'

/**
 * Admin settings: WhatsApp profile (name with verified-like emoji, about, avatar)
 * and connection (status + QR to pair the Evolution instance).
 */
export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('perfil')
  const [forbidden, setForbidden] = useState(false)

  // ── Profile ──────────────────────────────────────────────
  const [name, setName] = useState('')
  const [about, setAbout] = useState('')
  const [pictureUrl, setPictureUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  // ── Connection ───────────────────────────────────────────
  const [wa, setWa] = useState<{ ready: boolean; qr: string | null; canManage: boolean } | null>(null)
  const [reconnecting, setReconnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)

  const loadStatus = useCallback(() => {
    api.whatsappStatus().then(setWa).catch(() => setWa(null))
  }, [])

  useEffect(() => {
    api
      .whatsappProfile()
      .then((p) => {
        setName(p.name ?? '')
        setAbout(p.about ?? '')
        setPictureUrl(p.pictureUrl ?? '')
      })
      .catch(() => setForbidden(true))
      .finally(() => setLoading(false))
    loadStatus()
  }, [loadStatus])

  // Poll the connection status while on the Conexão tab (to catch QR/pairing).
  useEffect(() => {
    if (tab !== 'conexao') return
    loadStatus()
    const t = setInterval(loadStatus, 4000)
    return () => clearInterval(t)
  }, [tab, loadStatus])

  const save = async () => {
    setSaving(true)
    setMsg(null)
    try {
      await api.saveWhatsappProfile({ name, about, pictureUrl: pictureUrl || undefined })
      setMsg('Salvo e aplicado no número conectado. ✅')
    } catch {
      setMsg('Não foi possível salvar agora.')
    } finally {
      setSaving(false)
    }
  }

  const doReconnect = async () => {
    setReconnecting(true)
    try {
      await api.reconnectWhatsapp()
    } catch {
      /* ignore */
    } finally {
      setReconnecting(false)
      loadStatus()
    }
  }

  const doDisconnect = async () => {
    if (!confirm('Desconectar este número? A Alê para de atender até você parear outro número pelo QR.')) return
    setDisconnecting(true)
    try {
      const r = await api.disconnectWhatsapp()
      setWa({ ready: r.ready, qr: r.qr, canManage: true })
    } catch {
      /* ignore */
    } finally {
      setDisconnecting(false)
      // Give Evolution a moment, then refresh so the QR shows up.
      setTimeout(loadStatus, 1500)
    }
  }

  const addCheck = () => {
    if (!name.includes('✅')) setName((n) => `${n.trim()} ✅`.trim())
  }

  return (
    <div>
      <PageHeader title="Configurações" subtitle="Personalize o atendimento e gerencie os canais" />
      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        {forbidden ? (
          <div className="rounded-2xl border border-line bg-surface p-6 text-sm text-ink-soft shadow-sm">
            Apenas administradores podem acessar as configurações.
          </div>
        ) : (
          <div className="space-y-6">
            {/* Tabs */}
            <div className="flex gap-6 border-b border-line">
              <button
                onClick={() => setTab('perfil')}
                className={`-mb-px border-b-2 px-1 pb-3 text-sm font-semibold transition ${tab === 'perfil' ? 'border-alelo text-alelo' : 'border-transparent text-ink-soft hover:text-ink'}`}
              >
                Perfil
              </button>
              <button
                onClick={() => setTab('conexao')}
                className={`-mb-px border-b-2 px-1 pb-3 text-sm font-semibold transition ${tab === 'conexao' ? 'border-alelo text-alelo' : 'border-transparent text-ink-soft hover:text-ink'}`}
              >
                Canais
              </button>
            </div>

            {tab === 'perfil' &&
              (loading ? (
                <p className="text-sm text-ink-soft">Carregando…</p>
              ) : (
                <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
                  {/* Live preview card */}
                  <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm lg:col-span-1">
                    <h2 className="mb-4 text-sm font-semibold text-ink">Pré-visualização</h2>
                    <div className="flex flex-col items-center gap-3 rounded-xl bg-canvas p-5 text-center">
                      <span className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-full bg-alelo text-2xl font-bold text-white">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {pictureUrl ? <img src={pictureUrl} alt="avatar" className="h-full w-full object-cover" /> : 'A'}
                      </span>
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-ink">{name || 'Nome do número'}</div>
                        <div className="mt-0.5 text-xs text-ink-soft">{about || 'Recado / sobre'}</div>
                      </div>
                    </div>
                  </div>

                  {/* Form card */}
                  <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm lg:col-span-2">
                  <h2 className="mb-4 text-sm font-semibold text-ink">Perfil do WhatsApp</h2>

                  <label className="mb-1.5 block text-xs font-semibold text-ink-soft">Nome de exibição</label>
                  <div className="mb-4 flex gap-2">
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="flex-1 rounded-xl border border-line bg-canvas px-3 py-2.5 text-sm text-ink outline-none focus:border-alelo focus:ring-2 focus:ring-alelo/20"
                    />
                    <button
                      type="button"
                      onClick={addCheck}
                      className="shrink-0 rounded-xl border border-line px-3 text-sm font-semibold text-alelo hover:bg-canvas"
                      title="Adicionar selo de verificado"
                    >
                      + ✅
                    </button>
                  </div>

                  <label className="mb-1.5 block text-xs font-semibold text-ink-soft">Recado / sobre</label>
                  <textarea
                    value={about}
                    onChange={(e) => setAbout(e.target.value)}
                    rows={2}
                    className="mb-4 w-full resize-none rounded-xl border border-line bg-canvas px-3 py-2.5 text-sm text-ink outline-none focus:border-alelo focus:ring-2 focus:ring-alelo/20"
                  />

                  <label className="mb-1.5 block text-xs font-semibold text-ink-soft">Avatar (URL de imagem)</label>
                  <input
                    value={pictureUrl}
                    onChange={(e) => setPictureUrl(e.target.value)}
                    placeholder="https://…/logo.png"
                    className="mb-5 w-full rounded-xl border border-line bg-canvas px-3 py-2.5 text-sm text-ink outline-none focus:border-alelo focus:ring-2 focus:ring-alelo/20"
                  />

                  {msg && <p className="mb-3 rounded-lg bg-alelo-mint/60 px-3 py-2 text-sm text-alelo-dark">{msg}</p>}
                  <button
                    onClick={save}
                    disabled={saving || !name.trim()}
                    className="rounded-xl bg-alelo px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-alelo-dark disabled:opacity-50"
                  >
                    {saving ? 'Salvando…' : 'Salvar e aplicar'}
                  </button>
                  </div>
                </div>
              ))}

            {tab === 'conexao' && (
              <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
                    <span className="grid h-6 w-6 place-items-center rounded-md bg-alelo-mint text-sm">📱</span>
                    WhatsApp
                  </h2>
                  <div className="flex items-center gap-3">
                    <button onClick={loadStatus} className="text-xs font-semibold text-alelo hover:underline">
                      Atualizar
                    </button>
                    <button
                      onClick={doReconnect}
                      disabled={reconnecting}
                      className="rounded-lg bg-alelo px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-alelo-dark disabled:opacity-50"
                    >
                      {reconnecting ? 'Reconectando…' : 'Reconectar'}
                    </button>
                  </div>
                </div>
                <p className="mb-4 text-xs text-ink-soft">
                  Canal ativo hoje. Em breve: Instagram, e-mail e webchat — somos uma plataforma omnichannel.
                </p>

                {!wa ? (
                  <p className="text-sm text-ink-soft">Carregando estado…</p>
                ) : wa.ready ? (
                  <div className="flex items-center justify-between gap-3 rounded-xl bg-alelo-mint/50 p-4">
                    <div className="flex items-center gap-3">
                      <span className="grid h-11 w-11 place-items-center rounded-full bg-alelo text-white">
                        <IconCheck />
                      </span>
                      <div>
                        <p className="text-sm font-semibold text-alelo-dark">Conectado</p>
                        <p className="text-xs text-ink-soft">A Alê está atendendo por este número.</p>
                      </div>
                    </div>
                    <button
                      onClick={doDisconnect}
                      disabled={disconnecting}
                      className="shrink-0 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-600 transition hover:bg-red-50 disabled:opacity-50"
                    >
                      {disconnecting ? 'Desconectando…' : 'Desconectar'}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center gap-3 rounded-xl bg-amber-50 p-4">
                      <span className="grid h-11 w-11 place-items-center rounded-full bg-amber-100 text-amber-600">
                        <IconClock />
                      </span>
                      <div>
                        <p className="text-sm font-semibold text-amber-700">Desconectado</p>
                        <p className="text-xs text-ink-soft">Escaneie o QR Code abaixo para parear o número.</p>
                      </div>
                    </div>
                    {wa.qr ? (
                      <div className="flex flex-col items-center rounded-xl border border-line bg-canvas p-4">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={wa.qr} alt="QR WhatsApp" className="h-56 w-56 rounded-lg border border-line bg-white p-1" />
                        <p className="mt-2 text-xs text-ink-soft">
                          WhatsApp → Aparelhos conectados → Conectar um aparelho
                        </p>
                      </div>
                    ) : wa.canManage ? (
                      <a
                        href={`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3333'}/whatsapp/qr`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex text-sm font-semibold text-alelo hover:underline"
                      >
                        Abrir QR em nova aba →
                      </a>
                    ) : (
                      <p className="text-sm text-ink-soft">Gerando QR… clique em Atualizar.</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
