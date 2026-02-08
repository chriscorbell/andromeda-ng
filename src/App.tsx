import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import andromedaIcon from './assets/andromeda.png'

const HLS_URL = '/iptv/session/1/hls.m3u8'
const CHAT_API_URL = '/chat'
const CHAT_STORAGE_KEY = 'andromeda-chat-auth'
const ADMIN_USER = 'andromedatv'
const ADMIN_TOKEN_KEY = 'andromeda-chat-admin-token'

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

type AdminAction =
  | { kind: 'clear' }
  | { kind: 'delete'; messageId: number }
  | { kind: 'warn'; messageId: number }
  | { kind: 'ban'; nickname: string }
  | { kind: 'unban'; nickname: string }
  | { kind: 'delete-user'; nickname: string }

type AdminUser = {
  nickname: string
  created_at: string
}

type AdminMenuView = 'main' | 'active' | 'banned'

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
  const [nowTime, setNowTime] = useState(() => new Date())
  const [infoOpen, setInfoOpen] = useState(false)
  const [infoVisible, setInfoVisible] = useState(false)
  const [infoActive, setInfoActive] = useState(false)
  const [isMuted, setIsMuted] = useState(true)
  const [volume, setVolume] = useState(0.6)
  const [controlsVisible, setControlsVisible] = useState(false)
  const hideTimeoutRef = useRef<number | null>(null)
  const infoCloseTimeoutRef = useRef<number | null>(null)
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
  const [chatNotice, setChatNotice] = useState<string | null>(null)
  const [chatLoading, setChatLoading] = useState(false)
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null)
  const [cooldownRemaining, setCooldownRemaining] = useState<number | null>(null)
  const [adminAction, setAdminAction] = useState<AdminAction | null>(null)
  const [adminConfirmOpen, setAdminConfirmOpen] = useState(false)
  const [adminTokenOpen, setAdminTokenOpen] = useState(false)
  const [adminTokenInput, setAdminTokenInput] = useState('')
  const [adminTokenError, setAdminTokenError] = useState<string | null>(null)
  const [adminConfirmVisible, setAdminConfirmVisible] = useState(false)
  const [adminConfirmActive, setAdminConfirmActive] = useState(false)
  const [adminTokenVisible, setAdminTokenVisible] = useState(false)
  const [adminTokenActive, setAdminTokenActive] = useState(false)
  const adminConfirmTimeoutRef = useRef<number | null>(null)
  const adminTokenTimeoutRef = useRef<number | null>(null)
  const [adminMenuOpen, setAdminMenuOpen] = useState(false)
  const [adminMenuVisible, setAdminMenuVisible] = useState(false)
  const [adminMenuActive, setAdminMenuActive] = useState(false)
  const adminMenuTimeoutRef = useRef<number | null>(null)
  const [adminMenuView, setAdminMenuView] = useState<AdminMenuView>('main')
  const [adminMenuViewAnimating, setAdminMenuViewAnimating] = useState(false)
  const [adminUserList, setAdminUserList] = useState<AdminUser[]>([])
  const [adminUserSearch, setAdminUserSearch] = useState('')
  const [adminUserLoading, setAdminUserLoading] = useState(false)

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

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowTime(new Date())
    }, 1000)

    return () => {
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (!infoOpen) {
      return
    }

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setInfoOpen(false)
      }
    }

    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('keydown', handleKey)
    }
  }, [infoOpen])

  useEffect(() => {
    if (infoCloseTimeoutRef.current) {
      window.clearTimeout(infoCloseTimeoutRef.current)
      infoCloseTimeoutRef.current = null
    }

    if (infoOpen) {
      setInfoVisible(true)
      setInfoActive(false)
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          setInfoActive(true)
        })
      })
      return
    }

    if (infoVisible) {
      setInfoActive(false)
      infoCloseTimeoutRef.current = window.setTimeout(() => {
        setInfoVisible(false)
      }, 220)
    }
  }, [infoOpen, infoVisible])

  useEffect(() => {
    return () => {
      if (infoCloseTimeoutRef.current) {
        window.clearTimeout(infoCloseTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (adminConfirmTimeoutRef.current) {
      window.clearTimeout(adminConfirmTimeoutRef.current)
      adminConfirmTimeoutRef.current = null
    }

    if (adminConfirmOpen) {
      setAdminConfirmVisible(true)
      setAdminConfirmActive(false)
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          setAdminConfirmActive(true)
        })
      })
      return
    }

    if (adminConfirmVisible) {
      setAdminConfirmActive(false)
      adminConfirmTimeoutRef.current = window.setTimeout(() => {
        setAdminConfirmVisible(false)
      }, 200)
    }
  }, [adminConfirmOpen, adminConfirmVisible])

  useEffect(() => {
    if (adminTokenTimeoutRef.current) {
      window.clearTimeout(adminTokenTimeoutRef.current)
      adminTokenTimeoutRef.current = null
    }

    if (adminTokenOpen) {
      setAdminTokenVisible(true)
      setAdminTokenActive(false)
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          setAdminTokenActive(true)
        })
      })
      return
    }

    if (adminTokenVisible) {
      setAdminTokenActive(false)
      adminTokenTimeoutRef.current = window.setTimeout(() => {
        setAdminTokenVisible(false)
      }, 200)
    }
  }, [adminTokenOpen, adminTokenVisible])

  useEffect(() => {
    return () => {
      if (adminConfirmTimeoutRef.current) {
        window.clearTimeout(adminConfirmTimeoutRef.current)
      }
      if (adminTokenTimeoutRef.current) {
        window.clearTimeout(adminTokenTimeoutRef.current)
      }
      if (adminMenuTimeoutRef.current) {
        window.clearTimeout(adminMenuTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (adminMenuTimeoutRef.current) {
      window.clearTimeout(adminMenuTimeoutRef.current)
      adminMenuTimeoutRef.current = null
    }

    if (adminMenuOpen) {
      setAdminMenuVisible(true)
      setAdminMenuActive(false)
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          setAdminMenuActive(true)
        })
      })
      return
    }

    if (adminMenuVisible) {
      setAdminMenuActive(false)
      adminMenuTimeoutRef.current = window.setTimeout(() => {
        setAdminMenuVisible(false)
        setAdminMenuView('main')
        setAdminUserList([])
        setAdminUserSearch('')
      }, 200)
    }
  }, [adminMenuOpen, adminMenuVisible])


  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target) {
        return
      }

      if (target.closest('[data-admin-menu]')) {
        return
      }

      document
        .querySelectorAll<HTMLDetailsElement>('details[data-admin-menu][open]')
        .forEach((element) => {
          element.open = false
        })
    }

    document.addEventListener('click', handleOutsideClick)
    return () => {
      document.removeEventListener('click', handleOutsideClick)
    }
  }, [])

  const clearAuth = () => {
    setAuthToken(null)
    setAuthNickname(null)
    setAuthNicknameInput('')
    setAuthPasswordInput('')
    setAuthError(null)
    setChatNotice(null)
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

      publicStream.addEventListener('delete', (event) => {
        try {
          const payload = JSON.parse(event.data) as { id?: number }
          if (!payload.id) {
            return
          }
          setChatMessages((prev) =>
            prev.map((entry) =>
              entry.id === payload.id
                ? { ...entry, body: 'message deleted' }
                : entry,
            ),
          )
        } catch (error) {
          console.warn('Failed to parse delete event', error)
        }
      })

      publicStream.addEventListener('purge', (event) => {
        try {
          const payload = JSON.parse(event.data) as { nickname?: string }
          if (!payload.nickname) {
            return
          }
          setChatMessages((prev) =>
            prev.map((entry) =>
              entry.nickname === payload.nickname
                ? { ...entry, body: 'message deleted' }
                : entry,
            ),
          )
        } catch (error) {
          console.warn('Failed to parse purge event', error)
        }
      })

      publicStream.addEventListener('warn', (event) => {
        try {
          const payload = JSON.parse(event.data) as { nickname?: string }
          if (!payload.nickname || payload.nickname !== authNickname) {
            return
          }
          setChatNotice('you have been warned for your previous message')
        } catch (error) {
          console.warn('Failed to parse warn event', error)
        }
      })

      publicStream.addEventListener('ban', (event) => {
        try {
          const payload = JSON.parse(event.data) as { nickname?: string }
          if (!payload.nickname) {
            return
          }
          if (payload.nickname === authNickname) {
            clearAuth()
            setChatError('your account has been banned')
          }
        } catch (error) {
          console.warn('Failed to parse ban event', error)
        }
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

    stream.addEventListener('delete', (event) => {
      try {
        const payload = JSON.parse(event.data) as { id?: number }
        if (!payload.id) {
          return
        }
        setChatMessages((prev) =>
          prev.map((entry) =>
            entry.id === payload.id
              ? { ...entry, body: 'message deleted' }
              : entry,
          ),
        )
      } catch (error) {
        console.warn('Failed to parse delete event', error)
      }
    })

    stream.addEventListener('purge', (event) => {
      try {
        const payload = JSON.parse(event.data) as { nickname?: string }
        if (!payload.nickname) {
          return
        }
        setChatMessages((prev) =>
          prev.map((entry) =>
            entry.nickname === payload.nickname
              ? { ...entry, body: 'message deleted' }
              : entry,
          ),
        )
      } catch (error) {
        console.warn('Failed to parse purge event', error)
      }
    })

    stream.addEventListener('warn', (event) => {
      try {
        const payload = JSON.parse(event.data) as { nickname?: string }
        if (!payload.nickname || payload.nickname !== authNickname) {
          return
        }
        setChatNotice('you have been warned for your previous message')
      } catch (error) {
        console.warn('Failed to parse warn event', error)
      }
    })

    stream.addEventListener('ban', (event) => {
      try {
        const payload = JSON.parse(event.data) as { nickname?: string }
        if (!payload.nickname) {
          return
        }
        if (payload.nickname === authNickname) {
          clearAuth()
          setChatError('your account has been banned')
        }
      } catch (error) {
        console.warn('Failed to parse ban event', error)
      }
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

  useEffect(() => {
    if (!cooldownUntil) {
      setCooldownRemaining(null)
      return
    }

    const updateRemaining = () => {
      const remaining = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000))
      setCooldownRemaining(remaining)
      if (remaining === 0) {
        setCooldownUntil(null)
      }
    }

    updateRemaining()
    const timer = window.setInterval(updateRemaining, 1000)

    return () => {
      window.clearInterval(timer)
    }
  }, [cooldownUntil])

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
      setChatNotice(null)
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

    if (cooldownUntil && Date.now() < cooldownUntil) {
      setChatError("slow down, don't spam!")
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

      const payload = (await response.json()) as {
        error?: string
        cooldownSeconds?: number
      }

      if (!response.ok) {
        if (response.status === 429 && payload.cooldownSeconds) {
          setCooldownUntil(Date.now() + payload.cooldownSeconds * 1000)
          setChatError(payload.error || "slow down, don't spam!")
          return
        }
        setChatError(payload.error || 'Message failed to send.')
        return
      }

      setMessageBody('')
    } catch (error) {
      console.warn('Failed to send chat message', error)
      setChatError('Message failed to send.')
    }
  }

  const getStoredAdminToken = () => window.localStorage.getItem(ADMIN_TOKEN_KEY)

  const openAdminConfirm = (action: AdminAction) => {
    if (authNickname !== ADMIN_USER) {
      return
    }
    setAdminAction(action)
    setAdminConfirmOpen(true)
  }

  const performAdminAction = async (action: AdminAction, adminToken: string) => {
    try {
      if (action.kind === 'clear') {
        const response = await fetch(`${CHAT_API_URL}/admin/clear`, {
          method: 'POST',
          headers: {
            'X-Admin-Token': adminToken,
          },
        })

        if (!response.ok) {
          if (response.status === 401) {
            window.localStorage.removeItem(ADMIN_TOKEN_KEY)
            setChatError('Admin token invalid.')
            return
          }
          setChatError('Failed to clear chat history.')
          return
        }

        setChatError(null)
        return
      }

      if (action.kind === 'delete') {
        const response = await fetch(
          `${CHAT_API_URL}/admin/messages/${action.messageId}/delete`,
          {
            method: 'POST',
            headers: {
              'X-Admin-Token': adminToken,
            },
          },
        )

        if (!response.ok) {
          if (response.status === 401) {
            window.localStorage.removeItem(ADMIN_TOKEN_KEY)
            setChatError('Admin token invalid.')
            return
          }
          setChatError('Failed to delete message.')
          return
        }

        setChatMessages((prev) =>
          prev.map((entry) =>
            entry.id === action.messageId
              ? { ...entry, body: 'message deleted' }
              : entry,
          ),
        )
        setChatError(null)
        return
      }

      if (action.kind === 'warn') {
        const response = await fetch(
          `${CHAT_API_URL}/admin/messages/${action.messageId}/warn`,
          {
            method: 'POST',
            headers: {
              'X-Admin-Token': adminToken,
            },
          },
        )

        if (!response.ok) {
          if (response.status === 401) {
            window.localStorage.removeItem(ADMIN_TOKEN_KEY)
            setChatError('Admin token invalid.')
            return
          }
          setChatError('Failed to warn user.')
          return
        }

        setChatMessages((prev) =>
          prev.map((entry) =>
            entry.id === action.messageId
              ? { ...entry, body: 'message deleted' }
              : entry,
          ),
        )
        setChatError(null)
        return
      }

      if (action.kind === 'ban') {
        const response = await fetch(
          `${CHAT_API_URL}/admin/users/${encodeURIComponent(action.nickname)}/ban`,
          {
            method: 'POST',
            headers: {
              'X-Admin-Token': adminToken,
            },
          },
        )

        if (!response.ok) {
          if (response.status === 401) {
            window.localStorage.removeItem(ADMIN_TOKEN_KEY)
            setChatError('Admin token invalid.')
            return
          }
          setChatError('Failed to ban user.')
          return
        }

        setChatMessages((prev) =>
          prev.map((entry) =>
            entry.nickname === action.nickname
              ? { ...entry, body: 'message deleted' }
              : entry,
          ),
        )
        setChatError(null)
      }

      if (action.kind === 'unban') {
        const response = await fetch(
          `${CHAT_API_URL}/admin/users/${encodeURIComponent(action.nickname)}/unban`,
          {
            method: 'POST',
            headers: {
              'X-Admin-Token': adminToken,
            },
          },
        )

        if (!response.ok) {
          if (response.status === 401) {
            window.localStorage.removeItem(ADMIN_TOKEN_KEY)
            setChatError('Admin token invalid.')
            return
          }
          setChatError('Failed to unban user.')
          return
        }

        setChatError(null)
      }

      if (action.kind === 'delete-user') {
        const response = await fetch(
          `${CHAT_API_URL}/admin/users/${encodeURIComponent(action.nickname)}`,
          {
            method: 'DELETE',
            headers: {
              'X-Admin-Token': adminToken,
            },
          },
        )

        if (!response.ok) {
          if (response.status === 401) {
            window.localStorage.removeItem(ADMIN_TOKEN_KEY)
            setChatError('Admin token invalid.')
            return
          }
          setChatError('Failed to delete user.')
          return
        }

        setChatMessages((prev) =>
          prev.filter((entry) => entry.nickname !== action.nickname),
        )
        setChatError(null)
      }
    } catch (error) {
      console.warn('Failed to run admin action', error)
      setChatError('Admin action failed.')
    }
  }

  const confirmAdminAction = async () => {
    setAdminConfirmOpen(false)
    if (!adminAction) {
      return
    }

    const adminToken = getStoredAdminToken()
    if (!adminToken) {
      setAdminTokenInput('')
      setAdminTokenError(null)
      setAdminTokenOpen(true)
      return
    }

    await performAdminAction(adminAction, adminToken)
    setAdminAction(null)
  }

  const submitAdminToken = async () => {
    if (!adminAction) {
      setAdminTokenOpen(false)
      return
    }

    const token = adminTokenInput.trim()
    if (!token) {
      setAdminTokenError('Admin token required.')
      return
    }

    window.localStorage.setItem(ADMIN_TOKEN_KEY, token)
    setAdminTokenOpen(false)
    setAdminTokenInput('')
    setAdminTokenError(null)
    await performAdminAction(adminAction, token)
    setAdminAction(null)
  }

  const cancelAdminConfirm = () => {
    setAdminConfirmOpen(false)
    setAdminAction(null)
  }

  const cancelAdminToken = () => {
    setAdminTokenOpen(false)
    setAdminTokenInput('')
    setAdminTokenError(null)
    setAdminAction(null)
  }

  useEffect(() => {
    if (!adminConfirmOpen && !adminTokenOpen && !adminMenuOpen) {
      return
    }

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (adminConfirmOpen) {
          cancelAdminConfirm()
        }
        if (adminTokenOpen) {
          cancelAdminToken()
        }
        if (adminMenuOpen) {
          if (adminMenuView !== 'main') {
            backToAdminMain()
          } else {
            closeAdminMenu()
          }
        }
        return
      }

      if (event.key !== 'Enter') {
        return
      }

      if (adminTokenOpen) {
        void submitAdminToken()
        return
      }

      if (adminConfirmOpen) {
        void confirmAdminAction()
      }
    }

    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('keydown', handleKey)
    }
  }, [adminConfirmOpen, adminTokenOpen, adminAction, adminMenuOpen, adminMenuView])

  const closeAdminMenus = () => {
    document
      .querySelectorAll<HTMLDetailsElement>('details[data-admin-menu][open]')
      .forEach((element) => {
        element.open = false
      })
  }

  const fetchAdminUsers = async (view: 'active' | 'banned') => {
    const adminToken = getStoredAdminToken()
    if (!adminToken) {
      setAdminMenuOpen(false)
      setAdminTokenInput('')
      setAdminTokenError(null)
      setAdminTokenOpen(true)
      return
    }

    setAdminUserLoading(true)
    try {
      const endpoint = view === 'active' ? 'active' : 'banned'
      const response = await fetch(`${CHAT_API_URL}/admin/users/${endpoint}`, {
        headers: { 'X-Admin-Token': adminToken },
      })

      if (!response.ok) {
        if (response.status === 401) {
          window.localStorage.removeItem(ADMIN_TOKEN_KEY)
          setChatError('Admin token invalid.')
          setAdminMenuOpen(false)
          return
        }
        setChatError('Failed to load user list.')
        return
      }

      const payload = (await response.json()) as { users: AdminUser[] }
      setAdminUserList(payload.users)
    } catch (error) {
      console.warn('Failed to fetch admin users', error)
      setChatError('Failed to load user list.')
    } finally {
      setAdminUserLoading(false)
    }
  }

  const openAdminMenuView = async (view: 'active' | 'banned') => {
    setAdminUserSearch('')
    setAdminMenuViewAnimating(true)
    await new Promise((resolve) => window.setTimeout(resolve, 120))
    setAdminMenuView(view)
    await fetchAdminUsers(view)
    window.requestAnimationFrame(() => {
      setAdminMenuViewAnimating(false)
    })
  }

  const backToAdminMain = () => {
    setAdminMenuViewAnimating(true)
    window.setTimeout(() => {
      setAdminMenuView('main')
      setAdminUserList([])
      setAdminUserSearch('')
      window.requestAnimationFrame(() => {
        setAdminMenuViewAnimating(false)
      })
    }, 120)
  }

  const closeAdminMenu = () => {
    setAdminMenuOpen(false)
  }

  const handleAdminUserAction = (action: AdminAction) => {
    setAdminMenuOpen(false)
    openAdminConfirm(action)
  }

  const adminConfirmTitle = adminAction
    ? adminAction.kind === 'clear'
      ? 'clear chat history?'
      : adminAction.kind === 'delete'
        ? 'delete this message?'
        : adminAction.kind === 'warn'
          ? 'delete and warn this user?'
          : adminAction.kind === 'ban'
            ? `ban ${adminAction.nickname}?`
            : adminAction.kind === 'unban'
              ? `unban ${adminAction.nickname}?`
              : `delete user ${adminAction.nickname}?`
    : ''

  const adminConfirmBody = adminAction
    ? adminAction.kind === 'clear'
      ? 'this removes all messages, including system logs.'
      : adminAction.kind === 'delete'
        ? 'the message will be replaced with "message deleted".'
        : adminAction.kind === 'warn'
          ? 'the message will be deleted and the user will be warned.'
          : adminAction.kind === 'ban'
            ? 'the user will be banned and their messages will be redacted.'
            : adminAction.kind === 'unban'
              ? 'the user will be able to log in and chat again.'
              : 'the user account and all their messages will be permanently deleted.'
    : ''

  return (
    <div className="ui-body h-dvh w-full bg-[#050505] text-zinc-100">
      <div className="flex h-full w-full flex-col border border-zinc-800">
        <header className="flex h-12 items-center gap-3 border-b border-zinc-800 px-4 text-xs text-zinc-300">
          <img
            src={andromedaIcon}
            alt="andromeda"
            className="h-3.5 w-3.5 object-contain"
          />
          <span className="ui-header font-extrabold">andromeda</span>
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-2 text-zinc-500 transition hover:text-zinc-200 cursor-pointer"
            onClick={() => setInfoOpen(true)}
            aria-label="About andromeda"
          >
            info
          </button>
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
                    className="pointer-events-auto inline-flex h-6 w-6 items-center justify-center border border-zinc-700 text-zinc-200 transition hover:border-zinc-400"
                    onClick={handleToggleMute}
                    aria-label={isMuted ? 'Unmute' : 'Mute'}
                  >
                    {isMuted ? (
                      <svg
                        viewBox="0 0 24 24"
                        className="h-5 w-5"
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
                        className="h-5 w-5"
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
                <span className="ui-header font-extrabold">schedule</span>
                <span className="clock ml-auto text-zinc-500">
                  {nowTime
                    .toLocaleTimeString([], {
                      hour12: true,
                      hour: 'numeric',
                      minute: '2-digit',
                      second: '2-digit',
                    })
                    .split('')
                    .map((char, index) => (
                      <span
                        key={`${index}-${char}`}
                        className={/\d/.test(char) ? 'clock-digit' : undefined}
                      >
                        {char}
                      </span>
                    ))}
                </span>
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
                        className="text-zinc-300"
                      >
                        <button
                          type="button"
                          className={`schedule-row flex w-full items-center justify-between gap-3 rounded-md px-4 py-3 text-left text-zinc-100 transition ${hasDetails ? 'hover:bg-zinc-900/60 hover:text-white' : ''}`}
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
                          <span className="truncate text-zinc-400">
                            {item.title}
                          </span>
                          <span className="flex items-center gap-2">
                            {item.live ? (
                              <span className="flex items-center gap-2 text-zinc-200">
                                <span className="inline-flex h-1.5 w-1.5 rounded-full bg-[var(--color-accent-red)]" />
                                live
                              </span>
                            ) : (
                              <span className="text-zinc-500">
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
              <header className="flex h-12 items-center border-b border-zinc-800 px-4 text-zinc-300">
                <span className="ui-header font-extrabold">chat</span>
                {authNickname && (
                  <span className="ml-auto text-zinc-500">
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
                        <li className="px-4 py-6 text-zinc-500">
                          No messages yet.
                        </li>
                      )}
                      {chatMessages.map((entry) => (
                        <li
                          key={`${entry.id}`}
                          className="px-4 py-2 text-zinc-400 animate-[fadeIn_220ms_ease-out] motion-reduce:animate-none"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <span
                                className={
                                  entry.nickname === 'system'
                                    ? 'text-[#f7768e]'
                                    : entry.nickname === ADMIN_USER
                                      ? 'text-[#73daca]'
                                      : 'text-zinc-100'
                                }
                              >
                                {entry.nickname}
                              </span>{' '}
                              {entry.body === 'message deleted' ? (
                                <span className="italic text-zinc-500">message deleted</span>
                              ) : entry.nickname === 'system' ? (
                                <span className="italic text-zinc-500">{entry.body}</span>
                              ) : (
                                <span>{entry.body}</span>
                              )}
                            </div>
                            {authNickname === ADMIN_USER && (
                              <details className="relative shrink-0" data-admin-menu>
                                <summary className="list-none cursor-pointer text-xs text-zinc-500 transition hover:text-zinc-200">
                                  admin
                                </summary>
                                <div className="admin-menu absolute right-0 mt-1 w-40 border border-zinc-800 bg-[#050505] p-1 text-xs text-zinc-200 shadow-lg">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      openAdminConfirm({
                                        kind: 'delete',
                                        messageId: entry.id,
                                      })
                                      closeAdminMenus()
                                    }}
                                    className="block w-full px-2 py-1 text-left text-zinc-400 transition hover:text-zinc-100 cursor-pointer"
                                  >
                                    delete
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      openAdminConfirm({
                                        kind: 'warn',
                                        messageId: entry.id,
                                      })
                                      closeAdminMenus()
                                    }}
                                    className="block w-full px-2 py-1 text-left text-zinc-400 transition hover:text-zinc-100 cursor-pointer"
                                  >
                                    delete and warn
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      openAdminConfirm({
                                        kind: 'ban',
                                        nickname: entry.nickname,
                                      })
                                      closeAdminMenus()
                                    }}
                                    className="block w-full px-2 py-1 text-left text-zinc-400 transition hover:text-zinc-100 cursor-pointer"
                                  >
                                    ban
                                  </button>
                                </div>
                              </details>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <form
                    onSubmit={handleSendMessage}
                    className="border-t border-zinc-800 px-4 py-3"
                  >
                    {chatNotice && (
                      <div className="mb-2 text-[var(--color-accent-red)]">
                        {chatNotice}
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <input
                        value={messageBody}
                        onChange={(event) => setMessageBody(event.target.value)}
                        placeholder="Type a message"
                        disabled={Boolean(cooldownUntil)}
                        className="h-9 flex-1 border border-zinc-700 bg-black/40 px-3 text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-60"
                      />
                      <button
                        type="submit"
                        disabled={Boolean(cooldownUntil)}
                        className="h-9 border border-zinc-700 bg-zinc-900 px-3 text-zinc-100 transition hover:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        send
                      </button>
                    </div>
                    {chatError && (
                      <div className="mt-2 text-[var(--color-accent-red)]">
                        {chatError}
                        {cooldownRemaining !== null && (
                          <span className="ml-1 text-[var(--color-accent-red)]">
                            ({cooldownRemaining}s)
                          </span>
                        )}
                      </div>
                    )}
                    {chatLoading && (
                      <div className="mt-2 text-zinc-500">updating…</div>
                    )}
                    <div className="mt-2 flex items-center justify-between text-zinc-500">
                      <button
                        type="button"
                        className="text-zinc-400 hover:text-zinc-200"
                        onClick={clearAuth}
                      >
                        sign out
                      </button>
                      {authNickname === ADMIN_USER ? (
                        <button
                          type="button"
                          className="text-zinc-400 hover:text-zinc-200 cursor-pointer"
                          onClick={() => setAdminMenuOpen(true)}
                        >
                          admin
                        </button>
                      ) : (
                        <span aria-hidden="true" />
                      )}
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
                        <li className="px-4 py-6 text-zinc-500">
                          No messages yet.
                        </li>
                      )}
                      {chatMessages.map((entry) => (
                        <li
                          key={`${entry.id}`}
                          className="px-4 py-2 text-zinc-400 animate-[fadeIn_220ms_ease-out] motion-reduce:animate-none"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <span
                                className={
                                  entry.nickname === 'system'
                                    ? 'text-[#f7768e]'
                                    : entry.nickname === ADMIN_USER
                                      ? 'text-[#73daca]'
                                      : 'text-zinc-100'
                                }
                              >
                                {entry.nickname}
                              </span>{' '}
                              {entry.body === 'message deleted' ? (
                                <span className="italic text-zinc-500">message deleted</span>
                              ) : entry.nickname === 'system' ? (
                                <span className="italic text-zinc-500">{entry.body}</span>
                              ) : (
                                <span>{entry.body}</span>
                              )}
                            </div>
                            {authNickname === ADMIN_USER && (
                              <details className="relative shrink-0" data-admin-menu>
                                <summary className="list-none cursor-pointer text-xs text-zinc-500 transition hover:text-zinc-200">
                                  admin
                                </summary>
                                <div className="admin-menu absolute right-0 mt-1 w-40 border border-zinc-800 bg-[#050505] p-1 text-xs text-zinc-200 shadow-lg">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      openAdminConfirm({
                                        kind: 'delete',
                                        messageId: entry.id,
                                      })
                                      closeAdminMenus()
                                    }}
                                    className="block w-full px-2 py-1 text-left text-zinc-400 transition hover:text-zinc-100 cursor-pointer"
                                  >
                                    delete
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      openAdminConfirm({
                                        kind: 'warn',
                                        messageId: entry.id,
                                      })
                                      closeAdminMenus()
                                    }}
                                    className="block w-full px-2 py-1 text-left text-zinc-400 transition hover:text-zinc-100 cursor-pointer"
                                  >
                                    delete and warn
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      openAdminConfirm({
                                        kind: 'ban',
                                        nickname: entry.nickname,
                                      })
                                      closeAdminMenus()
                                    }}
                                    className="block w-full px-2 py-1 text-left text-zinc-400 transition hover:text-zinc-100 cursor-pointer"
                                  >
                                    ban
                                  </button>
                                </div>
                              </details>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <form
                    key={authMode}
                    onSubmit={handleAuthSubmit}
                    className="flex flex-col gap-3 border-t border-zinc-800 px-4 py-4 animate-[fadeIn_220ms_ease-out] motion-reduce:animate-none"
                  >
                    <div className="text-zinc-400">
                      {authMode === 'login' ? 'sign in to chat' : 'create an account'}
                    </div>
                    {chatError && (
                      <div className="text-[var(--color-accent-red)]">
                        {chatError}
                      </div>
                    )}
                    <input
                      value={authNicknameInput}
                      onChange={(event) => setAuthNicknameInput(event.target.value)}
                      placeholder="username"
                      className="h-9 border border-zinc-700 bg-black/40 px-3 text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
                    />
                    <input
                      type="password"
                      value={authPasswordInput}
                      onChange={(event) => setAuthPasswordInput(event.target.value)}
                      placeholder="password"
                      className="h-9 border border-zinc-700 bg-black/40 px-3 text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
                    />
                    <button
                      type="submit"
                      className="h-9 border border-zinc-700 bg-zinc-900 px-3 text-zinc-100 transition hover:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={authLoading}
                    >
                      {authLoading
                        ? 'working…'
                        : authMode === 'login'
                          ? 'sign in'
                          : 'create account'}
                    </button>
                    {authError && (
                      <div className="text-[var(--color-accent-red)]">{authError}</div>
                    )}
                    {chatLoading && (
                      <div className="text-zinc-500">updating…</div>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        setAuthMode((prev) => {
                          setChatNotice(null)
                          return prev === 'login' ? 'register' : 'login'
                        })
                      }
                      className="group inline-flex w-fit items-center gap-1 text-left text-zinc-400 transition-colors duration-200 ease-out hover:text-zinc-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-zinc-500 cursor-pointer"
                    >
                      {authMode === 'login'
                        ? 'need an account? create one'
                        : 'already have an account? sign in'}
                      <span className="text-zinc-500 transition-colors duration-200 ease-out group-hover:text-zinc-300">
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
      {adminMenuVisible && (
        <div
          className={`fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 transition-opacity duration-200 ${adminMenuActive ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
          onClick={closeAdminMenu}
        >
          <div
            className={`w-full max-w-md border border-zinc-800 bg-[#050505] text-zinc-200 shadow-xl transition duration-200 ${adminMenuActive ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-2 scale-95 opacity-0'}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className={`transition-opacity duration-120 ${adminMenuViewAnimating ? 'opacity-0' : 'opacity-100'}`}>
              {adminMenuView === 'main' && (
                <div className="p-6">
                  <div className="flex items-start justify-between gap-4">
                    <div className="ui-header font-extrabold">admin</div>
                    <button
                      type="button"
                      className="text-zinc-500 transition hover:text-zinc-200 cursor-pointer"
                      onClick={closeAdminMenu}
                      aria-label="Close admin menu"
                    >
                      close
                    </button>
                  </div>
                  <div className="mt-4 flex flex-col gap-2">
                    <button
                      type="button"
                      className="w-full border border-zinc-800 px-3 py-2 text-left text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-100 cursor-pointer"
                      onClick={() => {
                        closeAdminMenu()
                        openAdminConfirm({ kind: 'clear' })
                      }}
                    >
                      wipe chat
                    </button>
                    <button
                      type="button"
                      className="w-full border border-zinc-800 px-3 py-2 text-left text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-100 cursor-pointer"
                      onClick={() => void openAdminMenuView('active')}
                    >
                      active users
                    </button>
                    <button
                      type="button"
                      className="w-full border border-zinc-800 px-3 py-2 text-left text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-100 cursor-pointer"
                      onClick={() => void openAdminMenuView('banned')}
                    >
                      banned users
                    </button>
                  </div>
                </div>
              )}

              {(adminMenuView === 'active' || adminMenuView === 'banned') && (
                <div className="flex flex-col">
                  <div className="flex items-center gap-3 border-b border-zinc-800 px-6 py-4">
                    <button
                      type="button"
                      className="text-zinc-500 transition hover:text-zinc-200 cursor-pointer"
                      onClick={backToAdminMain}
                      aria-label="Back"
                    >
                      ←
                    </button>
                    <div className="ui-header font-extrabold">
                      {adminMenuView === 'active' ? 'active users' : 'banned users'}
                    </div>
                    <button
                      type="button"
                      className="ml-auto text-zinc-500 transition hover:text-zinc-200 cursor-pointer"
                      onClick={closeAdminMenu}
                      aria-label="Close admin menu"
                    >
                      close
                    </button>
                  </div>
                  <div className="px-6 pt-4">
                    <input
                      value={adminUserSearch}
                      onChange={(event) => setAdminUserSearch(event.target.value)}
                      placeholder="search users"
                      className="h-9 w-full border border-zinc-700 bg-black/40 px-3 text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
                      autoFocus
                    />
                  </div>
                  <div className="scrollbar-minimal max-h-64 min-h-[120px] overflow-y-auto px-6 py-3">
                    {adminUserLoading ? (
                      <div className="py-4 text-zinc-500">loading…</div>
                    ) : (() => {
                      const searchLower = adminUserSearch.toLowerCase()
                      const filtered = adminUserList.filter((user) =>
                        user.nickname.toLowerCase().includes(searchLower),
                      )
                      if (filtered.length === 0) {
                        return (
                          <div className="py-4 text-zinc-500">
                            {adminUserSearch ? 'no matching users' : 'no users'}
                          </div>
                        )
                      }
                      return (
                        <ul className="flex flex-col gap-1">
                          {filtered.map((user) => (
                            <li
                              key={user.nickname}
                              className="flex items-center justify-between gap-3 border-b border-zinc-800/50 py-2 last:border-0 animate-[fadeIn_120ms_ease-out] motion-reduce:animate-none"
                            >
                              <span className="truncate text-zinc-200">
                                {user.nickname}
                              </span>
                              <span className="flex shrink-0 items-center gap-2">
                                {adminMenuView === 'active' ? (
                                  <>
                                    <button
                                      type="button"
                                      className="text-zinc-500 transition hover:text-[#f7768e] cursor-pointer"
                                      onClick={() =>
                                        handleAdminUserAction({
                                          kind: 'ban',
                                          nickname: user.nickname,
                                        })
                                      }
                                    >
                                      ban
                                    </button>
                                    <button
                                      type="button"
                                      className="text-zinc-500 transition hover:text-[#f7768e] cursor-pointer"
                                      onClick={() =>
                                        handleAdminUserAction({
                                          kind: 'delete-user',
                                          nickname: user.nickname,
                                        })
                                      }
                                    >
                                      delete
                                    </button>
                                  </>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      className="text-zinc-500 transition hover:text-[#73daca] cursor-pointer"
                                      onClick={() =>
                                        handleAdminUserAction({
                                          kind: 'unban',
                                          nickname: user.nickname,
                                        })
                                      }
                                    >
                                      unban
                                    </button>
                                    <button
                                      type="button"
                                      className="text-zinc-500 transition hover:text-[#f7768e] cursor-pointer"
                                      onClick={() =>
                                        handleAdminUserAction({
                                          kind: 'delete-user',
                                          nickname: user.nickname,
                                        })
                                      }
                                    >
                                      delete
                                    </button>
                                  </>
                                )}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )
                    })()}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {adminConfirmVisible && adminAction && (
        <div
          className={`fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 transition-opacity duration-200 ${adminConfirmActive ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
          onClick={cancelAdminConfirm}
        >
          <div
            className={`w-full max-w-md border border-zinc-800 bg-[#050505] p-6 text-zinc-200 shadow-xl transition duration-200 ${adminConfirmActive ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-2 scale-95 opacity-0'
              }`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="ui-header font-extrabold">confirm</div>
            <p className="mt-3 text-zinc-400">{adminConfirmTitle}</p>
            {adminConfirmBody && (
              <p className="mt-2 text-zinc-500">{adminConfirmBody}</p>
            )}
            <div className="mt-4 flex items-center justify-end gap-3">
              <button
                type="button"
                className="text-zinc-400 transition hover:text-zinc-100 cursor-pointer"
                onClick={cancelAdminConfirm}
              >
                cancel
              </button>
              <button
                type="button"
                className="border border-zinc-700 bg-zinc-900 px-3 py-1 text-zinc-100 transition hover:border-zinc-500 cursor-pointer"
                onClick={confirmAdminAction}
              >
                confirm
              </button>
            </div>
          </div>
        </div>
      )}
      {adminTokenVisible && (
        <div
          className={`fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 transition-opacity duration-200 ${adminTokenActive ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
          onClick={cancelAdminToken}
        >
          <div
            className={`w-full max-w-md border border-zinc-800 bg-[#050505] p-6 text-zinc-200 shadow-xl transition duration-200 ${adminTokenActive ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-2 scale-95 opacity-0'
              }`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="ui-header font-extrabold">admin token</div>
            <p className="mt-3 text-zinc-400">
              enter the admin token to continue.
            </p>
            <input
              type="password"
              value={adminTokenInput}
              onChange={(event) => setAdminTokenInput(event.target.value)}
              placeholder="admin token"
              className="mt-3 h-9 w-full border border-zinc-700 bg-black/40 px-3 text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
            />
            {adminTokenError && (
              <div className="mt-2 text-[var(--color-accent-red)]">
                {adminTokenError}
              </div>
            )}
            <div className="mt-4 flex items-center justify-end gap-3">
              <button
                type="button"
                className="text-zinc-400 transition hover:text-zinc-100 cursor-pointer"
                onClick={cancelAdminToken}
              >
                cancel
              </button>
              <button
                type="button"
                className="border border-zinc-700 bg-zinc-900 px-3 py-1 text-zinc-100 transition hover:border-zinc-500 cursor-pointer"
                onClick={submitAdminToken}
              >
                continue
              </button>
            </div>
          </div>
        </div>
      )}
      {infoVisible && (
        <div
          className={`fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 transition-opacity duration-200 ${infoActive ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
          onClick={() => setInfoOpen(false)}
        >
          <div
            className={`w-full max-w-lg border border-zinc-800 bg-[#050505] p-6 text-zinc-200 shadow-xl transition duration-200 ${infoActive ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-2 scale-95 opacity-0'
              }`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="ui-header font-extrabold">about</div>
              <button
                type="button"
                className="text-zinc-500 transition hover:text-zinc-200 cursor-pointer"
                onClick={() => setInfoOpen(false)}
                aria-label="Close info"
              >
                close
              </button>
            </div>
            <div>
              <p className="mt-3 text-zinc-400">
                andromeda is a 24/7 experimental anime stream with a live
                schedule and community chat, built with:
              </p>
              <ul className="mt-3 space-y-1 text-zinc-400">
                <li>- typescript</li>
                <li>- react</li>
                <li>- tailwind</li>
                <li>- vite</li>
                <li>- bun</li>
                <li>- nginx</li>
              </ul>
              <p className="mt-3 text-zinc-400">
                it has a simple account system and a custom chat backend with
                a rolling message history.
              </p>
              <p className="mt-3 text-zinc-400">
                sign in or create an account to join the chat - no email or verification needed.
                passwords are securely hashed and salted before being stored.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
