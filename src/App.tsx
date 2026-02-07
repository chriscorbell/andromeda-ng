import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import andromedaIcon from './assets/andromeda.png'

const HLS_URL = '/iptv/session/1/hls.m3u8'
const CHAT_API_URL = '/chat'
const CHAT_STORAGE_KEY = 'andromeda-chat-auth'

type ScheduleItem = {
  title: string
  episode?: string
  time?: string
  description?: string
  live?: boolean
  start?: Date
  stop?: Date
}

type ChatMessage = {
  id: number
  nickname: string
  body: string
  created_at: string
}

const fallbackSchedule: ScheduleItem[] = [
  {
    title: 'Angel Cop',
    episode: 'S01E03 The Death Warrant',
    time: 'live',
    description: 'A captured criminal reveals the depths of the Red May conspiracy.',
    live: true,
  },
  { title: 'Genocyber', time: '8:46 PM - 9:13 PM' },
  { title: 'Dragon Ball Z', time: '9:13 PM - 9:37 PM' },
  { title: 'Mobile Suit Gundam', time: '9:37 PM - 9:52 PM' },
  { title: 'Bubblegum Crisis: Tokyo 2040', time: '9:52 PM - 10:09 PM' },
  { title: 'Trigun', time: '10:09 PM - 10:25 PM' },
  { title: 'Cowboy Bebop', time: '10:25 PM - 10:41 PM' },
]

const parseXmltvDate = (value?: string | null) => {
  if (!value) {
    return null
  }

  const [stamp, offset = ''] = value.trim().split(' ')
  if (!stamp || stamp.length < 14) {
    return null
  }

  const year = Number(stamp.slice(0, 4))
  const month = Number(stamp.slice(4, 6)) - 1
  const day = Number(stamp.slice(6, 8))
  const hour = Number(stamp.slice(8, 10))
  const minute = Number(stamp.slice(10, 12))
  const second = Number(stamp.slice(12, 14))

  let dateUtc = Date.UTC(year, month, day, hour, minute, second)

  if (offset && /^[+-]\d{4}$/.test(offset)) {
    const sign = offset.startsWith('-') ? -1 : 1
    const offsetHours = Number(offset.slice(1, 3))
    const offsetMinutes = Number(offset.slice(3, 5))
    const totalMinutes = sign * (offsetHours * 60 + offsetMinutes)
    dateUtc -= totalMinutes * 60_000
  }

  return new Date(dateUtc)
}

const formatTimeRange = (start?: Date, stop?: Date) => {
  if (!start || !stop) {
    return undefined
  }

  const options: Intl.DateTimeFormatOptions = {
    hour: 'numeric',
    minute: '2-digit',
  }
  const startLabel = start.toLocaleTimeString([], options)
  const stopLabel = stop.toLocaleTimeString([], options)
  return `${startLabel} - ${stopLabel}`
}

const cleanXmltvText = (value?: string | null) => {
  if (!value) {
    return undefined
  }

  const normalized = value.replace(/<br\s*\/?\s*>/gi, '\n')
  const container = document.createElement('div')
  container.innerHTML = normalized
  const text = container.textContent
    ?.replace(/\s+\n/g, '\n')
    .replace(/\n?\s*Source:\s*[^\n]+\s*$/i, '')
    .trim()
  return text || undefined
}

const parseEpisodePrefix = (program: Element) => {
  const episodeNode = program.querySelector('episode-num')
  if (!episodeNode) {
    return undefined
  }

  const system = episodeNode.getAttribute('system') || 'xmltv_ns'
  const raw = episodeNode.textContent?.trim()
  if (!raw) {
    return undefined
  }

  if (system === 'xmltv_ns') {
    const [seasonRaw, episodeRaw] = raw.split('.')
    const seasonIndex = Number(seasonRaw)
    const episodeIndex = Number(episodeRaw)
    if (Number.isFinite(seasonIndex) && Number.isFinite(episodeIndex)) {
      const season = String(seasonIndex + 1).padStart(2, '0')
      const episode = String(episodeIndex + 1).padStart(2, '0')
      return `S${season}E${episode}`
    }
  }

  const match = raw.match(/S(\d+)E(\d+)/i)
  if (match) {
    const season = String(Number(match[1])).padStart(2, '0')
    const episode = String(Number(match[2])).padStart(2, '0')
    return `S${season}E${episode}`
  }

  return undefined
}

function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const videoFrameRef = useRef<HTMLDivElement | null>(null)
  const chatScrollRef = useRef<HTMLDivElement | null>(null)
  const chatStreamRef = useRef<EventSource | null>(null)
  const [isMuted, setIsMuted] = useState(true)
  const [volume, setVolume] = useState(0.6)
  const [controlsVisible, setControlsVisible] = useState(false)
  const hideTimeoutRef = useRef<number | null>(null)
  const [schedule, setSchedule] = useState<ScheduleItem[]>(fallbackSchedule)
  const [expandedScheduleKey, setExpandedScheduleKey] = useState<string | null>(
    null,
  )
  const scheduleTimeoutRef = useRef<number | null>(null)
  const scheduleIntervalRef = useRef<number | null>(null)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [authToken, setAuthToken] = useState<string | null>(null)
  const [authNickname, setAuthNickname] = useState<string | null>(null)
  const [authNicknameInput, setAuthNicknameInput] = useState('')
  const [authPasswordInput, setAuthPasswordInput] = useState('')
  const [authError, setAuthError] = useState<string | null>(null)
  const [authLoading, setAuthLoading] = useState(false)
  const [messageBody, setMessageBody] = useState('')
  const [chatError, setChatError] = useState<string | null>(null)
  const [chatLoading, setChatLoading] = useState(false)

  useEffect(() => {
    const video = videoRef.current

    if (!video) {
      return
    }

    video.muted = isMuted
    video.volume = volume

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = HLS_URL
      return
    }

    if (!Hls.isSupported()) {
      return
    }

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
    })

    hls.loadSource(HLS_URL)
    hls.attachMedia(video)

    return () => {
      hls.destroy()
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const loadSchedule = async () => {
      try {
        if (scheduleTimeoutRef.current) {
          window.clearTimeout(scheduleTimeoutRef.current)
        }

        const response = await fetch('/iptv/xmltv.xml')
        if (!response.ok) {
          return
        }

        const xmlText = await response.text()
        const doc = new DOMParser().parseFromString(xmlText, 'text/xml')
        const allPrograms = Array.from(doc.querySelectorAll('programme'))
        const channelNodes = Array.from(doc.querySelectorAll('channel'))
        const channelMatch = channelNodes.find((channel) => {
          const names = Array.from(channel.querySelectorAll('display-name'))
            .map((node) => node.textContent?.trim()?.toLowerCase())
            .filter(Boolean)
          return (
            names.includes('1') ||
            names.includes('1 andromeda') ||
            names.includes('andromeda')
          )
        })
        const channelId = channelMatch?.getAttribute('id') ?? '1'
        const channelPrograms = allPrograms.filter(
          (program) => program.getAttribute('channel') === channelId,
        )
        const programs = channelPrograms.length ? channelPrograms : allPrograms

        const items = programs
          .map((program): ScheduleItem | null => {
            const title = program.querySelector('title')?.textContent?.trim()
            if (!title) {
              return null
            }

            const episodeTitle = cleanXmltvText(
              program.querySelector('sub-title')?.textContent,
            )
            const episodePrefix = parseEpisodePrefix(program)
            const episode = episodeTitle
              ? `${episodePrefix ? `${episodePrefix} ` : ''}${episodeTitle}`
              : episodePrefix
            const description = cleanXmltvText(
              program.querySelector('desc')?.textContent,
            )
            const start = parseXmltvDate(program.getAttribute('start')) || undefined
            const stop = parseXmltvDate(program.getAttribute('stop')) || undefined

            return {
              title,
              start,
              stop,
              ...(episode ? { episode } : {}),
              ...(description ? { description } : {}),
            }
          })
          .filter((item): item is ScheduleItem => item !== null)
          .sort((a, b) => (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0))

        if (!items.length || cancelled) {
          return
        }

        const now = new Date()
        const currentIndex = items.findIndex(
          (item) =>
            item.start && item.stop && item.start <= now && now < item.stop,
        )
        const startIndex = currentIndex >= 0 ? currentIndex : 0

        const sliced = items.slice(startIndex, startIndex + 25).map((item, idx) => {
          const isLive = idx === 0 && currentIndex >= 0
          return {
            ...item,
            live: isLive,
            time: isLive ? 'live' : formatTimeRange(item.start, item.stop),
          }
        })

        if (!cancelled) {
          setSchedule(sliced)
        }

      } catch (error) {
        console.warn('Failed to load schedule', error)
      }
    }

    void loadSchedule()

    scheduleIntervalRef.current = window.setInterval(() => {
      void loadSchedule()
    }, 10_000)

    return () => {
      cancelled = true
      if (scheduleTimeoutRef.current) {
        window.clearTimeout(scheduleTimeoutRef.current)
      }
      if (scheduleIntervalRef.current) {
        window.clearInterval(scheduleIntervalRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!videoRef.current) {
      return
    }

    videoRef.current.muted = isMuted
  }, [isMuted])

  useEffect(() => {
    if (!videoRef.current) {
      return
    }

    videoRef.current.volume = volume
  }, [volume])

  const handleToggleMute = () => {
    setIsMuted((prev) => !prev)
  }

  const handleVolumeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = Number(event.target.value)
    setVolume(next)
    if (next > 0 && isMuted) {
      setIsMuted(false)
    }
  }

  const handleFullscreen = () => {
    const frame = videoFrameRef.current
    if (!frame) {
      return
    }

    if (document.fullscreenElement) {
      void document.exitFullscreen()
      return
    }

    void frame.requestFullscreen()
  }

  const showControls = () => {
    setControlsVisible(true)
    if (hideTimeoutRef.current) {
      window.clearTimeout(hideTimeoutRef.current)
    }
    hideTimeoutRef.current = window.setTimeout(() => {
      setControlsVisible(false)
    }, 2200)
  }

  const scheduleHideControls = () => {
    if (hideTimeoutRef.current) {
      window.clearTimeout(hideTimeoutRef.current)
    }
    hideTimeoutRef.current = window.setTimeout(() => {
      setControlsVisible(false)
    }, 600)
  }

  useEffect(() => {
    return () => {
      if (hideTimeoutRef.current) {
        window.clearTimeout(hideTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const raw = window.localStorage.getItem(CHAT_STORAGE_KEY)
    if (!raw) {
      return
    }

    try {
      const stored = JSON.parse(raw) as { nickname?: string; token?: string }
      if (stored?.token && stored?.nickname) {
        setAuthToken(stored.token)
        setAuthNickname(stored.nickname)
      }
    } catch (error) {
      console.warn('Failed to read stored chat auth', error)
    }
  }, [])

  const clearAuth = () => {
    setAuthToken(null)
    setAuthNickname(null)
    setAuthNicknameInput('')
    setAuthPasswordInput('')
    setAuthError(null)
    if (chatStreamRef.current) {
      chatStreamRef.current.close()
      chatStreamRef.current = null
    }
    window.localStorage.removeItem(CHAT_STORAGE_KEY)
  }

  const fetchMessages = async () => {
    if (!authToken) {
      return
    }

    setChatLoading(true)
    setChatError(null)

    try {
      const response = await fetch(`${CHAT_API_URL}/messages`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      })

      if (response.status === 401) {
        clearAuth()
        return
      }

      if (!response.ok) {
        throw new Error('Failed to load messages')
      }

      const payload = (await response.json()) as { messages: ChatMessage[] }
      setChatMessages(payload.messages)
    } catch (error) {
      console.warn('Failed to load chat messages', error)
      setChatError('Unable to load messages. Try again in a moment.')
    } finally {
      setChatLoading(false)
    }
  }

  const fetchPublicMessages = async () => {
    setChatLoading(true)
    setChatError(null)

    try {
      const response = await fetch(`${CHAT_API_URL}/messages/public`)
      if (!response.ok) {
        throw new Error('Failed to load public messages')
      }

      const payload = (await response.json()) as { messages: ChatMessage[] }
      setChatMessages(payload.messages)
    } catch (error) {
      console.warn('Failed to load public chat messages', error)
      setChatError('Unable to load messages. Try again in a moment.')
    } finally {
      setChatLoading(false)
    }
  }

  useEffect(() => {
    if (!authToken) {
      if (chatStreamRef.current) {
        chatStreamRef.current.close()
        chatStreamRef.current = null
      }
      void fetchPublicMessages()
      const publicStreamUrl = new URL(
        `${CHAT_API_URL}/messages/public/stream`,
        window.location.origin,
      )
      const publicStream = new EventSource(publicStreamUrl.toString())
      chatStreamRef.current = publicStream

      publicStream.addEventListener('ready', () => {
        setChatError(null)
      })

      publicStream.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(event.data) as ChatMessage
          setChatMessages((prev) => {
            if (prev.some((entry) => entry.id === message.id)) {
              return prev
            }
            const next = [...prev, message]
            return next.length > 100 ? next.slice(-100) : next
          })
          setChatError(null)
        } catch (error) {
          console.warn('Failed to parse chat message', error)
        }
      })

      publicStream.addEventListener('clear', () => {
        setChatMessages([])
      })

      publicStream.addEventListener('error', () => {
        setChatError('Chat connection lost. Reconnecting...')
      })

      return () => {
        publicStream.close()
        if (chatStreamRef.current === publicStream) {
          chatStreamRef.current = null
        }
      }
    }

    void fetchMessages()

    const streamUrl = new URL(`${CHAT_API_URL}/messages/stream`, window.location.origin)
    streamUrl.searchParams.set('token', authToken)
    const stream = new EventSource(streamUrl.toString())
    chatStreamRef.current = stream

    stream.addEventListener('ready', () => {
      setChatError(null)
    })

    stream.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data) as ChatMessage
        setChatMessages((prev) => {
          if (prev.some((entry) => entry.id === message.id)) {
            return prev
          }
          const next = [...prev, message]
          return next.length > 100 ? next.slice(-100) : next
        })
        setChatError(null)
      } catch (error) {
        console.warn('Failed to parse chat message', error)
      }
    })

    stream.addEventListener('clear', () => {
      setChatMessages([])
    })

    stream.addEventListener('error', () => {
      setChatError('Chat connection lost. Reconnecting...')
    })

    return () => {
      stream.close()
      if (chatStreamRef.current === stream) {
        chatStreamRef.current = null
      }
    }
  }, [authToken])

  useEffect(() => {
    if (!chatScrollRef.current) {
      return
    }

    chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight
  }, [chatMessages.length])

  const handleAuthSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setAuthError(null)
    setAuthLoading(true)

    try {
      const response = await fetch(
        `${CHAT_API_URL}/auth/${authMode === 'login' ? 'login' : 'register'}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            nickname: authNicknameInput.trim(),
            password: authPasswordInput,
          }),
        },
      )

      const payload = (await response.json()) as { nickname?: string; token?: string; error?: string }

      if (!response.ok || !payload.token || !payload.nickname) {
        setAuthError(payload.error || 'Unable to sign in. Check your details.')
        return
      }

      setAuthToken(payload.token)
      setAuthNickname(payload.nickname)
      setAuthPasswordInput('')
      setMessageBody('')
      window.localStorage.setItem(
        CHAT_STORAGE_KEY,
        JSON.stringify({ nickname: payload.nickname, token: payload.token }),
      )
    } catch (error) {
      console.warn('Auth failed', error)
      setAuthError('Unable to sign in. Try again in a moment.')
    } finally {
      setAuthLoading(false)
    }
  }

  const handleSendMessage = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!authToken) {
      return
    }

    const trimmed = messageBody.trim()
    if (!trimmed) {
      return
    }

    setChatError(null)

    try {
      const response = await fetch(`${CHAT_API_URL}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ body: trimmed }),
      })

      if (response.status === 401) {
        clearAuth()
        return
      }

      if (!response.ok) {
        throw new Error('Failed to send message')
      }

      await response.json()
      setMessageBody('')
    } catch (error) {
      console.warn('Failed to send chat message', error)
      setChatError('Message failed to send.')
    }
  }

  return (
    <div className="h-dvh w-full bg-[#050505] text-zinc-100">
      <div className="flex h-full w-full flex-col border border-zinc-800">
        <header className="flex h-12 items-center gap-3 border-b border-zinc-800 px-4 text-xs text-zinc-300">
          <img
            src={andromedaIcon}
            alt="andromeda"
            className="h-3.5 w-3.5 object-contain"
          />
          <span className="text-lg font-extrabold">andromeda</span>
        </header>
        <div className="layout-shell flex min-h-0 flex-1 flex-col animate-[fadeIn_700ms_ease-out] motion-reduce:animate-none lg:grid lg:grid-cols-[auto_minmax(240px,1fr)]">
          <div className="flex min-h-0 items-stretch lg:h-full">
            <div
              ref={videoFrameRef}
              className="video-frame scanlines relative aspect-[4/3] h-auto w-full max-h-[60vh] overflow-hidden bg-black lg:h-full lg:w-auto lg:max-h-full"
              onMouseMove={showControls}
              onMouseEnter={showControls}
              onMouseLeave={scheduleHideControls}
              onFocusCapture={showControls}
            >
              <video
                ref={videoRef}
                className="absolute inset-0 h-full w-full object-contain"
                muted
                autoPlay
                playsInline
                onContextMenu={(event) => event.preventDefault()}
              />
              <div
                className={`pointer-events-none absolute bottom-2 right-2 inline-flex items-center justify-end bg-black/60 px-3 py-2 text-[11px] text-zinc-200 transition-opacity duration-200 ${controlsVisible ? 'opacity-100' : 'opacity-0'
                  }`}
              >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="pointer-events-auto border border-zinc-700 p-1 text-zinc-200 transition hover:border-zinc-400"
                    onClick={handleToggleMute}
                    aria-label={isMuted ? 'Unmute' : 'Mute'}
                  >
                    {isMuted ? (
                      <svg
                        viewBox="0 0 24 24"
                        className="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M10 8.5L7.2 11H5v2h2.2l2.8 2.5V8.5z" />
                        <path d="M15 9l4 6" />
                        <path d="M19 9l-4 6" />
                      </svg>
                    ) : (
                      <svg
                        viewBox="0 0 24 24"
                        className="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M10 8.5L7.2 11H5v2h2.2l2.8 2.5V8.5z" />
                        <path d="M14 10a3 3 0 010 4" />
                        <path d="M16.5 8a6 6 0 010 8" />
                      </svg>
                    )}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.02}
                    value={volume}
                    onChange={handleVolumeChange}
                    className="volume-slider pointer-events-auto h-1 w-24 cursor-pointer"
                    aria-label="Volume"
                  />
                  <button
                    type="button"
                    className="pointer-events-auto border border-zinc-700 p-1 text-zinc-200 transition hover:border-zinc-400"
                    onClick={handleFullscreen}
                    aria-label="Toggle fullscreen"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className="h-4 w-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M8 4H4v4" />
                      <path d="M16 4h4v4" />
                      <path d="M4 16v4h4" />
                      <path d="M20 16v4h-4" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <aside className="flex min-h-0 flex-1 flex-col border-t border-zinc-800 lg:border-l lg:border-t-0">
            <div className="flex min-h-0 flex-[1] flex-col">
              <header className="flex h-12 items-center border-b border-zinc-800 px-4 text-xs text-zinc-300">
                <span className="text-lg font-extrabold">schedule</span>
              </header>
              <div className="scrollbar-minimal min-h-0 flex-1 overflow-y-auto">
                <ul className="divide-y divide-zinc-800">
                  {schedule.map((item) => {
                    const itemKey = `${item.title}-${item.time}`
                    const isExpanded = expandedScheduleKey === itemKey
                    const hasDetails = Boolean(item.episode || item.description)

                    return (
                      <li
                        key={itemKey}
                        className="px-4 py-3 text-sm text-zinc-300"
                      >
                        <button
                          type="button"
                          className={`schedule-row flex w-full items-center justify-between gap-3 rounded-md text-left text-zinc-100 transition ${hasDetails ? 'hover:bg-zinc-900/60 hover:text-white' : ''}`}
                          onClick={() =>
                            setExpandedScheduleKey((prev) =>
                              prev === itemKey ? null : itemKey,
                            )
                          }
                          aria-expanded={isExpanded}
                          data-expanded={isExpanded}
                          data-clickable={hasDetails}
                          disabled={!hasDetails}
                        >
                          <span className="truncate text-xs text-zinc-400">
                            {item.title}
                          </span>
                          <span className="flex items-center gap-2">
                            {item.live ? (
                              <span className="flex items-center gap-2 text-[11px] text-zinc-200">
                                <span className="inline-flex h-1.5 w-1.5 rounded-full bg-[var(--color-accent-red)]" />
                                live
                              </span>
                            ) : (
                              <span className="text-[11px] text-zinc-500">
                                {item.time}
                              </span>
                            )}
                            {hasDetails && (
                              <svg
                                viewBox="0 0 24 24"
                                className="schedule-chevron h-4 w-4"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                              >
                                <path d="M6 9l6 6 6-6" />
                              </svg>
                            )}
                          </span>
                        </button>
                        {hasDetails && (
                          <div
                            className="schedule-details"
                            data-expanded={isExpanded}
                          >
                            {item.episode && (
                              <div className="text-xs text-zinc-500">
                                {item.episode}
                              </div>
                            )}
                            {item.description && (
                              <p className="text-xs text-zinc-400">
                                {item.description}
                              </p>
                            )}
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>
            </div>

            <div className="flex min-h-0 flex-[2] flex-col border-t border-zinc-800">
              <header className="flex h-12 items-center border-b border-zinc-800 px-4 text-xs text-zinc-300">
                <span className="text-lg font-extrabold">chat</span>
                {authNickname && (
                  <span className="ml-auto text-[11px] text-zinc-500">
                    signed in as <span className="text-zinc-200">{authNickname}</span>
                  </span>
                )}
              </header>
              {authToken ? (
                <>
                  <div
                    ref={chatScrollRef}
                    className="scrollbar-minimal min-h-0 flex-1 overflow-y-auto"
                  >
                    <ul className="divide-y divide-zinc-800">
                      {chatMessages.length === 0 && !chatLoading && (
                        <li className="px-4 py-6 text-xs text-zinc-500">
                          No messages yet.
                        </li>
                      )}
                      {chatMessages.map((entry) => (
                        <li
                          key={`${entry.id}`}
                          className="px-4 py-2 text-xs text-zinc-400"
                        >
                          <span className="text-zinc-100">{entry.nickname}</span>{' '}
                          <span>{entry.body}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <form
                    onSubmit={handleSendMessage}
                    className="border-t border-zinc-800 px-4 py-3 text-[11px]"
                  >
                    <div className="flex items-center gap-2">
                      <input
                        value={messageBody}
                        onChange={(event) => setMessageBody(event.target.value)}
                        placeholder="Type a message"
                        className="h-9 flex-1 border border-zinc-700 bg-black/40 px-3 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
                      />
                      <button
                        type="submit"
                        className="h-9 border border-zinc-700 bg-zinc-900 px-3 text-xs text-zinc-100 transition hover:border-zinc-500"
                      >
                        send
                      </button>
                    </div>
                    {chatError && (
                      <div className="mt-2 text-[11px] text-[var(--color-accent-red)]">
                        {chatError}
                      </div>
                    )}
                    {chatLoading && (
                      <div className="mt-2 text-[11px] text-zinc-500">updating…</div>
                    )}
                    <div className="mt-2 text-[11px] text-zinc-500">
                      <button
                        type="button"
                        className="text-zinc-400 hover:text-zinc-200"
                        onClick={clearAuth}
                      >
                        sign out
                      </button>
                    </div>
                  </form>
                </>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div
                    ref={chatScrollRef}
                    className="scrollbar-minimal min-h-0 flex-1 overflow-y-auto"
                  >
                    <ul className="divide-y divide-zinc-800">
                      {chatMessages.length === 0 && !chatLoading && (
                        <li className="px-4 py-6 text-xs text-zinc-500">
                          No messages yet.
                        </li>
                      )}
                      {chatMessages.map((entry) => (
                        <li
                          key={`${entry.id}`}
                          className="px-4 py-2 text-xs text-zinc-400"
                        >
                          <span className="text-zinc-100">{entry.nickname}</span>{' '}
                          <span>{entry.body}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <form
                    key={authMode}
                    onSubmit={handleAuthSubmit}
                    className="flex flex-col gap-3 border-t border-zinc-800 px-4 py-4 text-[11px] animate-[fadeIn_220ms_ease-out] motion-reduce:animate-none"
                  >
                    <div className="text-xs text-zinc-400">
                      {authMode === 'login' ? 'sign in to chat' : 'create an account'}
                    </div>
                    <input
                      value={authNicknameInput}
                      onChange={(event) => setAuthNicknameInput(event.target.value)}
                      placeholder="username"
                      className="h-9 border border-zinc-700 bg-black/40 px-3 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
                    />
                    <input
                      type="password"
                      value={authPasswordInput}
                      onChange={(event) => setAuthPasswordInput(event.target.value)}
                      placeholder="password"
                      className="h-9 border border-zinc-700 bg-black/40 px-3 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
                    />
                    <button
                      type="submit"
                      className="h-9 border border-zinc-700 bg-zinc-900 px-3 text-xs text-zinc-100 transition hover:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={authLoading}
                    >
                      {authLoading
                        ? 'working…'
                        : authMode === 'login'
                          ? 'sign in'
                          : 'create account'}
                    </button>
                    {authError && (
                      <div className="text-[11px] text-[var(--color-accent-red)]">{authError}</div>
                    )}
                    {chatError && (
                      <div className="text-[11px] text-[var(--color-accent-red)]">{chatError}</div>
                    )}
                    {chatLoading && (
                      <div className="text-[11px] text-zinc-500">updating…</div>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        setAuthMode((prev) =>
                          prev === 'login' ? 'register' : 'login',
                        )
                      }
                      className="group inline-flex w-fit items-center gap-1 text-left text-zinc-400 transition-colors duration-200 ease-out hover:text-zinc-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-zinc-500 cursor-pointer"
                    >
                      {authMode === 'login'
                        ? 'need an account? create one'
                        : 'already have an account? sign in'}
                      <span className="text-[10px] text-zinc-500 transition-colors duration-200 ease-out group-hover:text-zinc-300">
                        →
                      </span>
                    </button>
                  </form>
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}

export default App
