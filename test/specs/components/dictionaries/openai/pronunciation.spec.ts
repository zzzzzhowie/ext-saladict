import {
  buildPhonemeSSML,
  parseIPAVariants,
  toGooglePhonemes
} from '@/components/dictionaries/openai/pronunciation'

describe('openai pronunciation', () => {
  it('parses a single transcription', () => {
    expect(parseIPAVariants('/kəˈdeɪn/')).toEqual([
      { display: '/kəˈdeɪn/', label: '', ipa: 'kəˈdeɪn' }
    ])
  })

  it('parses heteronym readings with their sense labels', () => {
    expect(parseIPAVariants('/lɪv/ (v.) · /laɪv/ (adj.)')).toEqual([
      { display: '/lɪv/', label: '(v.)', ipa: 'lɪv' },
      { display: '/laɪv/', label: '(adj.)', ipa: 'laɪv' }
    ])
  })

  it('keeps an undelimited transcription as-is', () => {
    expect(parseIPAVariants('kəˈdeɪn')).toEqual([
      { display: 'kəˈdeɪn', label: '', ipa: 'kəˈdeɪn' }
    ])
    expect(parseIPAVariants('')).toEqual([])
  })

  it('passes an already-valid transcription through', () => {
    expect(toGooglePhonemes('kəˈdeɪn')).toBe('kəˈdeɪn')
    expect(toGooglePhonemes('/laɪv/')).toBe('laɪv')
    expect(toGooglePhonemes('ˈmʌnˌdeɪn')).toBe('ˈmʌnˌdeɪn')
  })

  it("maps broad US transcriptions onto Google's phoneme set", () => {
    expect(toGooglePhonemes('ˈpærɪti')).toBe('ˈpæɹɪtiː')
    expect(toGooglePhonemes('ˈwɔtər')).toBe('ˈwɔːtɚ')
    expect(toGooglePhonemes('ˈwɔːɾɚ')).toBe('ˈwɔːtɚ')
    expect(toGooglePhonemes('bɝd')).toBe('bɚd')
    expect(toGooglePhonemes('kɑr')).toBe('kɑːɹ')
    expect(toGooglePhonemes('ˈɡʊɡəl')).toBe('ˈɡʊɡəl')
    expect(toGooglePhonemes('gɪt')).toBe('ɡɪt')
    expect(toGooglePhonemes('ˈtʃɝtʃ')).toBe('ˈʧɚʧ')
    expect(toGooglePhonemes('d͡ʒʌdʒ')).toBe('ʤʌʤ')
    expect(toGooglePhonemes('ˈbʌtn̩')).toBe('ˈbʌtn')
    expect(toGooglePhonemes("kə'deɪn")).toBe('kəˈdeɪn')
    expect(toGooglePhonemes('fuːd')).toBe('fuːd')
    expect(toGooglePhonemes('fud')).toBe('fuːd')
    expect(toGooglePhonemes('bɔɪ')).toBe('bɔɪ')
    expect(toGooglePhonemes('ˈɑrkeɪn')).toBe('ˈɑːɹkeɪn')
    expect(toGooglePhonemes('əˈmɛrɪkə')).toBe('əˈmɛɹɪkə')
  })

  it('speaks the first of several alternatives', () => {
    expect(toGooglePhonemes('ˈdeɪtə, ˈdætə')).toBe('ˈdeɪtə')
    expect(toGooglePhonemes('ˈdeɪtə or ˈdætə')).toBe('ˈdeɪtə')
  })

  it('gives up on symbols Google cannot read', () => {
    expect(toGooglePhonemes('bɑx')).toBe('')
    expect(toGooglePhonemes('')).toBe('')
  })

  it('builds escaped phoneme SSML', () => {
    expect(buildPhonemeSSML("Kadane's", 'kəˈdeɪnz')).toBe(
      '<speak><phoneme alphabet="ipa" ph="kəˈdeɪnz">Kadane&#39;s</phoneme></speak>'
    )
  })
})
