# Welcome to Cue

Good evening, and thank you for joining us. Tonight I want to talk about
something we all take for granted: **reading out loud**.

When you read from a teleprompter, the machine usually sets the pace, and
you become its servant. If you slow down to let a moment land, the words
drift away from you. If you speed up, you find yourself chasing the text
down the screen.

## A prompter that listens

This prompter works the other way around. It listens to your voice,
figures out *where you are* in the script, and gently keeps that spot at
the reading line.

Try it yourself:

* Read a few sentences at a normal pace.
* Now slow right down, as if you were delivering bad news.
* Then rush a little, like you are running out of airtime.

Notice how the text keeps up with you, not the other way around. You can
pause entirely — take a sip of water — and the prompter simply waits.

## Under the hood

Everything happens on your device. A small speech recognition model runs
directly in the browser, transcribing your voice a few seconds at a time.
Your audio and transcript never leave this device.

The transcript is matched against the script with a fuzzy alignment, so
the occasional misheard word does not throw it off course. Skip a
sentence, improvise a little, and it will catch up with you at the next
phrase it recognises.

That is the whole idea: a prompter that follows the speaker. Thank you
very much, and enjoy the show.
