/* Configuração do Gestor VTT */
window.GESTOR_CONFIG = {
  // Projeto no Supabase (Project Settings → API Keys). A publishable key pode ficar pública.
  // NUNCA coloque aqui a secret key (sb_secret_...).
  supabaseUrl: 'https://cliqlclzctivckujpxzp.supabase.co',
  supabaseKey: 'sb_publishable__xO1r9qe_Rd60ylGl1QDfA_7YoGVR7A',

  // Endereço do site (ex.: 'https://vttstore.vercel.app'). Só serve para o Gestor mostrar
  // fotos antigas que estejam na pasta img/produtos do site. Fotos enviadas pelo Gestor não precisam.
  siteUrl: '',

  // De quanto em quanto tempo o Gestor procura pedidos novos (segundos). 0 = desliga.
  atualizarACada: 60,
};
