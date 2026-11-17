package com.lymoon.raazi

import android.content.Context
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/**
 * The phone's own voices, for Raazi's Listen button.
 *
 * Android's WebView has no speech synthesis, so phone.js stands in a
 * `speechSynthesis` that forwards here: "speak", "stop", "voices". Events go
 * back as `{ev, id}`. Everything this receives arrives on the main thread;
 * the engine's callbacks do not, so `emit` has to post.
 */
class PhoneVoice(context: Context, private val emit: (String) -> Unit) : TextToSpeech.OnInitListener {

    private val tts = TextToSpeech(context.applicationContext, this)
    private var ready = false
    private var failed = false
    /** Asked for before the engine was up; spoken once it is. */
    private val waiting = mutableListOf<JSONObject>()
    private var byName: Map<String, Voice> = emptyMap()

    override fun onInit(status: Int) {
        if (status != TextToSpeech.SUCCESS) {
            failed = true
            for (m in waiting) emit(JSONObject().put("ev", "error").put("id", m.optLong("id")).toString())
            waiting.clear()
            return
        }
        ready = true
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(id: String) = event("start", id)
            override fun onDone(id: String) = event("end", id)
            @Deprecated("Deprecated in Java")
            override fun onError(id: String) = event("error", id)
            override fun onError(id: String, errorCode: Int) = event("error", id)
            // Stopped on purpose (cancel or pause): the page already knows.
            override fun onStop(id: String, interrupted: Boolean) = Unit
        })
        sendVoices()
        val queued = waiting.toList()
        waiting.clear()
        queued.forEach(::speak)
    }

    fun handle(message: JSONObject) {
        when (message.optString("op")) {
            "hello", "voices" -> if (ready) sendVoices()
            "speak" -> when {
                ready -> speak(message)
                failed -> emit(JSONObject().put("ev", "error").put("id", message.optLong("id")).toString())
                else -> waiting.add(message)
            }
            "stop" -> {
                waiting.clear()
                if (ready) tts.stop()
            }
        }
    }

    private fun speak(m: JSONObject) {
        val voice = byName[m.optString("voice")]
        if (voice != null) {
            tts.voice = voice
        } else {
            val lang = m.optString("lang")
            val locale = if (lang.isBlank()) Locale.getDefault() else Locale.forLanguageTag(lang)
            if (tts.isLanguageAvailable(locale) >= TextToSpeech.LANG_AVAILABLE) tts.language = locale
        }
        tts.setSpeechRate(m.optDouble("rate", 1.0).toFloat().coerceIn(0.1f, 4f))
        tts.setPitch(m.optDouble("pitch", 1.0).toFloat().coerceIn(0.1f, 2f))
        val params = Bundle().apply {
            putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, m.optDouble("volume", 1.0).toFloat().coerceIn(0f, 1f))
        }
        val id = m.optLong("id").toString()
        if (tts.speak(m.optString("text"), TextToSpeech.QUEUE_ADD, params, id) != TextToSpeech.SUCCESS) event("error", id)
    }

    private fun event(kind: String, id: String) {
        emit(JSONObject().put("ev", kind).put("id", id.toLongOrNull() ?: return).toString())
    }

    /**
     * Installed voices only — one marked "not installed" would be offered and
     * then say nothing. Named for a person choosing one: "Arabic (Egypt) ·
     * arz-local".
     */
    private fun sendVoices() {
        val installed = (tts.voices ?: emptySet()).filter {
            TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED !in it.features
        }.sortedWith(compareBy({ it.locale.toLanguageTag() }, { it.isNetworkConnectionRequired }, { it.name }))
        byName = installed.associateBy { it.name }
        val default = tts.defaultVoice?.name
        val list = JSONArray()
        for (v in installed) {
            val place = v.locale.getDisplayName(Locale.ENGLISH)
            val variant = v.name.substringAfter("-x-", v.name)
            list.put(
                JSONObject()
                    .put("voiceURI", v.name)
                    .put("name", "$place · $variant")
                    .put("lang", v.locale.toLanguageTag())
                    .put("localService", !v.isNetworkConnectionRequired)
                    .put("default", v.name == default)
            )
        }
        emit(JSONObject().put("voices", list).toString())
    }

    fun shutdown() {
        runCatching { tts.stop() }
        runCatching { tts.shutdown() }
    }
}
