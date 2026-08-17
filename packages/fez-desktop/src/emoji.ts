/**
 * The emoji set — curated and bundled (the CSP allows nothing external,
 * and a chat client shouldn't need 20k glyphs to feel complete). Names
 * follow the common :shortcode: vocabulary so muscle memory from other
 * chat apps carries over.
 */

const RAW = `
smile 😄 grin 😁 joy 😂 rofl 🤣 slight_smile 🙂 wink 😉 blush 😊 innocent 😇
heart_eyes 😍 star_struck 🤩 kissing_heart 😘 yum 😋 tongue 😛 zany 🤪 hug 🤗
thinking 🤔 shush 🤫 neutral 😐 expressionless 😑 smirk 😏 unamused 😒 eye_roll 🙄
grimace 😬 relieved 😌 pensive 😔 sleepy 😪 sleeping 😴 mask 😷 thermometer_face 🤒
dizzy_face 😵 exploding_head 🤯 cowboy 🤠 sunglasses 😎 nerd 🤓 monocle 🧐
confused 😕 worried 😟 frown 🙁 open_mouth 😮 astonished 😲 flushed 😳 pleading 🥺
cry 😢 sob 😭 scream 😱 angry 😠 rage 😡 skull 💀 clown 🤡 ghost 👻 alien 👽
robot 🤖 poop 💩 fire 🔥 sparkles ✨ star ⭐ zap ⚡ boom 💥 sweat_drops 💦
tada 🎉 confetti 🎊 balloon 🎈 gift 🎁 trophy 🏆 medal 🏅 crown 👑 gem 💎
heart ❤️ orange_heart 🧡 yellow_heart 💛 green_heart 💚 blue_heart 💙 purple_heart 💜
black_heart 🖤 broken_heart 💔 heart_on_fire ❤️‍🔥 hundred 💯 anger 💢
thumbsup 👍 thumbsdown 👎 ok_hand 👌 pinch 🤏 v ✌️ crossed_fingers 🤞 metal 🤘
call_me 🤙 point_left 👈 point_right 👉 point_up 👆 point_down 👇 raised_hand ✋
wave 👋 clap 👏 raised_hands 🙌 open_hands 👐 handshake 🤝 pray 🙏 muscle 💪
writing_hand ✍️ nail_care 💅 eyes 👀 eye 👁 brain 🧠 tooth 🦷 bone 🦴
speaking_head 🗣 bust 👤 people 👥 baby 👶 detective 🕵️ mage 🧙 zombie 🧟
dog 🐶 cat 🐱 mouse 🐭 rabbit 🐰 fox 🦊 bear 🐻 panda 🐼 koala 🐨 tiger 🐯
lion 🦁 cow 🐮 pig 🐷 frog 🐸 monkey 🐵 see_no_evil 🙈 hear_no_evil 🙉
speak_no_evil 🙊 chicken 🐔 penguin 🐧 bird 🐦 eagle 🦅 owl 🦉 bat 🦇 wolf 🐺
unicorn 🦄 bee 🐝 bug 🐛 butterfly 🦋 snail 🐌 ant 🐜 spider 🕷 scorpion 🦂
turtle 🐢 snake 🐍 octopus 🐙 squid 🦑 shrimp 🦐 crab 🦀 whale 🐳 dolphin 🐬
fish 🐟 shark 🦈 crocodile 🐊 dragon 🐉 dinosaur 🦕 trex 🦖
apple 🍎 pear 🍐 orange 🍊 lemon 🍋 banana 🍌 watermelon 🍉 grapes 🍇
strawberry 🍓 cherries 🍒 peach 🍑 mango 🥭 pineapple 🍍 coconut 🥥 kiwi 🥝
avocado 🥑 eggplant 🍆 potato 🥔 carrot 🥕 corn 🌽 hot_pepper 🌶 broccoli 🥦
mushroom 🍄 peanuts 🥜 bread 🍞 cheese 🧀 egg 🥚 bacon 🥓 pancakes 🥞 fries 🍟
pizza 🍕 hamburger 🍔 hotdog 🌭 taco 🌮 burrito 🌯 sushi 🍣 ramen 🍜 curry 🍛
spaghetti 🍝 cookie 🍪 cake 🍰 birthday 🎂 cupcake 🧁 chocolate 🍫 candy 🍬
lollipop 🍭 honey 🍯 popcorn 🍿 doughnut 🍩 coffee ☕ tea 🍵 beer 🍺 beers 🍻
wine 🍷 cocktail 🍸 tropical_drink 🍹 champagne 🍾 milk 🥛
soccer ⚽ basketball 🏀 football 🏈 baseball ⚾ tennis 🎾 bowling 🎳 golf ⛳
dart 🎯 game_die 🎲 chess ♟ video_game 🎮 joystick 🕹 slot_machine 🎰 puzzle 🧩
guitar 🎸 piano 🎹 trumpet 🎺 violin 🎻 drum 🥁 microphone 🎤 headphones 🎧
art 🎨 clapper 🎬 ticket 🎫 circus 🎪
car 🚗 taxi 🚕 bus 🚌 racecar 🏎 police_car 🚓 ambulance 🚑 fire_engine 🚒
truck 🚚 tractor 🚜 bike 🚲 scooter 🛴 motorcycle 🏍 train 🚆 metro 🚇
airplane ✈️ rocket 🚀 flying_saucer 🛸 helicopter 🚁 boat ⛵ ship 🚢 anchor ⚓
construction 🚧 fuel_pump ⛽ traffic_light 🚦 world_map 🗺 compass 🧭
mountain ⛰ volcano 🌋 camping 🏕 beach 🏖 desert 🏜 island 🏝 park 🏞
house 🏠 office 🏢 hospital 🏥 bank 🏦 hotel 🏨 school 🏫 factory 🏭 castle 🏰
sunrise 🌅 sunset 🌇 night_stars 🌃 milky_way 🌌 rainbow 🌈 sun ☀️ moon 🌙
full_moon 🌕 new_moon 🌑 star2 🌟 shooting_star 🌠 cloud ☁️ rain 🌧 thunder ⛈
snowflake ❄️ snowman ⛄ wind 🌬 tornado 🌪 fog 🌫 umbrella ☂️ droplet 💧 wave_water 🌊
watch ⌚ phone 📱 laptop 💻 keyboard ⌨️ desktop 🖥 printer 🖨 mouse_device 🖱
cd 💿 floppy 💾 camera 📷 video_camera 📹 tv 📺 radio 📻 battery 🔋 plug 🔌
bulb 💡 flashlight 🔦 candle 🕯 satellite 📡 telescope 🔭 microscope 🔬
book 📖 books 📚 notebook 📓 ledger 📒 page 📄 newspaper 📰 bookmark 🔖
label 🏷 moneybag 💰 dollar 💵 credit_card 💳 chart_up 📈 chart_down 📉
clipboard 📋 pushpin 📌 paperclip 📎 scissors ✂️ pen 🖊 pencil ✏️ memo 📝
briefcase 💼 folder 📁 calendar 📅 mailbox 📫 package 📦 envelope ✉️
lock 🔒 unlock 🔓 key 🔑 hammer 🔨 axe 🪓 wrench 🔧 gear ⚙️ magnet 🧲
gun 🔫 bomb 💣 knife 🔪 shield 🛡 cigarette 🚬 pill 💊 syringe 💉 dna 🧬
microbe 🦠 test_tube 🧪 telescope2 🔭 broom 🧹 basket 🧺 soap 🧼 sponge 🧽
bell 🔔 no_bell 🔕 loudspeaker 📢 mega 📣 sound 🔊 mute 🔇 hourglass ⌛
alarm ⏰ stopwatch ⏱ infinity ♾ warning ⚠️ no_entry ⛔ prohibited 🚫
check ✅ cross ❌ question ❓ exclamation ❗ recycle ♻️ trident 🔱
flag_white 🏳️ flag_black 🏴 pirate 🏴‍☠️ checkered_flag 🏁 triangular_flag 🚩
`;

export interface EmojiEntry {
  name: string;
  char: string;
}

export const EMOJI: EmojiEntry[] = RAW.trim()
  .split(/\s+/)
  .reduce<EmojiEntry[]>((list, token, index, tokens) => {
    if (index % 2 === 0) list.push({ name: token, char: tokens[index + 1] ?? "" });
    return list;
  }, [])
  .filter((entry) => entry.char);

export function searchEmoji(query: string, limit = 24): EmojiEntry[] {
  const q = query.toLowerCase();
  return EMOJI.filter((entry) => entry.name.includes(q))
    .sort((a, b) => Number(b.name.startsWith(q)) - Number(a.name.startsWith(q)) || a.name.localeCompare(b.name))
    .slice(0, limit);
}
