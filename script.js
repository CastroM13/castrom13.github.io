const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

class ThemeManager {
  constructor() {
    this.theme = localStorage.getItem('theme') || 'dark';
    this.themeToggle = $('#theme-toggle');
    this.init();
  }

  init() {
    this.setTheme(this.theme);
    this.themeToggle?.addEventListener('click', () => this.toggleTheme());
  }

  setTheme(theme) {
    this.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }

  toggleTheme() {
    const newTheme = this.theme === 'light' ? 'dark' : 'light';
    this.setTheme(newTheme);
  }
}

class NavigationManager {
  constructor() {
    this.navbar = $('.navbar');
    this.navMenu = $('.nav-menu');
    this.hamburger = $('.hamburger');
    this.navLinks = $$('.nav-link');
    this.sections = $$('section[id]');
    this.init();
  }

  init() {
    this.hamburger?.addEventListener('click', () => this.toggleMobileMenu());
    this.navLinks.forEach(link => {
      link.addEventListener('click', (e) => this.handleNavClick(e));
    });
    
    window.addEventListener('scroll', () => {
      this.handleScroll();
      this.updateActiveNavLink();
    });
    
        document.addEventListener('click', (e) => {
      if (!this.navbar.contains(e.target)) {
        this.closeMobileMenu();
      }
    });
  }

  toggleMobileMenu() {
    this.navMenu?.classList.toggle('active');
    this.hamburger?.classList.toggle('active');
  }

  closeMobileMenu() {
    this.navMenu?.classList.remove('active');
    this.hamburger?.classList.remove('active');
  }

  handleNavClick(e) {
    const href = e.target.getAttribute('href');
    if (href?.startsWith('#')) {
      e.preventDefault();
      const targetId = href.substring(1);
      const targetSection = $(`#${targetId}`);
      
      if (targetSection) {
        const offsetTop = targetSection.offsetTop - 80;
        window.scrollTo({
          top: offsetTop,
          behavior: 'smooth'
        });
      }
      
      this.closeMobileMenu();
    }
  }

  handleScroll() {
    const scrolled = window.pageYOffset > 50;
    this.navbar?.classList.toggle('scrolled', scrolled);
  }

  updateActiveNavLink() {
    let currentSection = '';
    
    this.sections.forEach(section => {
      const sectionTop = section.offsetTop - 100;
      const sectionHeight = section.offsetHeight;
      
      if (window.pageYOffset >= sectionTop && 
          window.pageYOffset < sectionTop + sectionHeight) {
        currentSection = section.getAttribute('id');
      }
    });

    this.navLinks.forEach(link => {
      link.classList.remove('active');
      const href = link.getAttribute('href');
      if (href === `#${currentSection}`) {
        link.classList.add('active');
      }
    });
  }
}

class ScrollAnimations {
  constructor() {
    this.animatedElements = $$('[data-animate]');
    this.observer = null;
    this.init();
  }

  init() {
    if ('IntersectionObserver' in window) {
      this.observer = new IntersectionObserver(
        (entries) => this.handleIntersection(entries),
        {
          threshold: 0.1,
          rootMargin: '0px 0px -50px 0px'
        }
      );

      this.animatedElements.forEach(el => this.observer.observe(el));
    }
  }

  handleIntersection(entries) {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const element = entry.target;
        const animationType = element.dataset.animate;
        element.classList.add(`animate-${animationType}`);
        this.observer.unobserve(element);
      }
    });
  }
}

class ContactForm {
  constructor() {
    this.form = $('#contact-form');
    this.init();
  }

  init() {
    this.form?.addEventListener('submit', (e) => this.handleSubmit(e));
  }

  async handleSubmit(e) {
    e.preventDefault();
    
    const formData = new FormData(this.form);
    const data = Object.fromEntries(formData.entries());
    
        const submitBtn = this.form.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Sending...';
    submitBtn.disabled = true;

    try {
            await this.simulateFormSubmission(data);
      
            this.showMessage('Message sent successfully! I\'ll get back to you soon.', 'success');
      this.form.reset();
      
    } catch (error) {
      console.error('Form submission error:', error);
      this.showMessage('Sorry, there was an error sending your message. Please try again.', 'error');
    } finally {
            submitBtn.textContent = originalText;
      submitBtn.disabled = false;
    }
  }

  async simulateFormSubmission(data) {
        return new Promise((resolve, reject) => {
      setTimeout(() => {
                if (Math.random() > 0.1) {
          resolve(data);
        } else {
          reject(new Error('Simulated network error'));
        }
      }, 1500);
    });
  }

  showMessage(message, type) {
        const existingMessage = $('.form-message');
    if (existingMessage) {
      existingMessage.remove();
    }

        const messageEl = document.createElement('div');
    messageEl.className = `form-message form-message--${type}`;
    messageEl.textContent = message;
    
        messageEl.style.cssText = `
      padding: 1rem;
      margin-top: 1rem;
      border-radius: 8px;
      font-weight: 500;
      ${type === 'success' 
        ? 'background: #dcfce7; color: #166534; border: 1px solid #bbf7d0;' 
        : 'background: #fef2f2; color: #dc2626; border: 1px solid #fecaca;'
      }
    `;

    this.form.appendChild(messageEl);

        setTimeout(() => {
      messageEl.remove();
    }, 5000);
  }
}

class ProjectCards {
  constructor() {
    this.cards = $$('.project-card');
    this.init();
  }

  init() {
    this.cards.forEach(card => {
      card.addEventListener('mouseenter', () => this.handleMouseEnter(card));
      card.addEventListener('mouseleave', () => this.handleMouseLeave(card));
    });
  }

  handleMouseEnter(card) {
    const image = card.querySelector('.project-image img');
    if (image) {
      image.style.transform = 'scale(1.1)';
    }
  }

  handleMouseLeave(card) {
    const image = card.querySelector('.project-image img');
    if (image) {
      image.style.transform = 'scale(1)';
    }
  }
}

class ParallaxEffects {
  constructor() {
    this.parallaxElements = $$('[data-parallax]');
    this.init();
  }

  init() {
    if (this.parallaxElements.length > 0) {
      window.addEventListener('scroll', () => this.handleScroll());
    }
  }

  handleScroll() {
    const scrolled = window.pageYOffset;
    
    this.parallaxElements.forEach(element => {
      const speed = parseFloat(element.dataset.parallax) || 0.5;
      const yPos = -(scrolled * speed);
      element.style.transform = `translateY(${yPos}px)`;
    });
  }
}

class RevealAnimations {
  constructor() {
    this.revealElements = $$('.skill-tag, .project-card, .timeline-item');
    this.init();
  }

  init() {
    if ('IntersectionObserver' in window) {
      this.observer = new IntersectionObserver(
        (entries) => this.handleIntersection(entries),
        {
          threshold: 0.1,
          rootMargin: '0px 0px -100px 0px'
        }
      );

      this.revealElements.forEach((el, index) => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(30px)';
        el.style.transition = `opacity 0.6s ease ${index * 0.1}s, transform 0.6s ease ${index * 0.1}s`;
        this.observer.observe(el);
      });
    }
  }

  handleIntersection(entries) {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const element = entry.target;
        element.style.opacity = '1';
        element.style.transform = 'translateY(0)';
        this.observer.unobserve(element);
      }
    });
  }
}

class TypingAnimation {
  constructor() {
    this.element = $('.hero-title');
    this.text = 'Technology Researcher & Software Developer';
    this.speed = 100;
    this.init();
  }

  init() {
    if (this.element) {
      this.element.textContent = '';
      this.typeText();
    }
  }

  async typeText() {
    for (let i = 0; i < this.text.length; i++) {
      this.element.textContent += this.text.charAt(i);
      await new Promise(resolve => setTimeout(resolve, this.speed));
    }
  }
}

class PerformanceMonitor {
  constructor() {
    this.init();
  }

  init() {
        window.addEventListener('load', () => {
      if ('performance' in window) {
        const perfData = performance.getEntriesByType('navigation')[0];
        console.log('Page Load Time:', perfData.loadEventEnd - perfData.fetchStart, 'ms');
      }
    });

        let ticking = false;
    window.addEventListener('scroll', () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          ticking = false;
        });
        ticking = true;
      }
    });
  }
}

class ErrorHandler {
  constructor() {
    this.init();
  }

  init() {
    window.addEventListener('error', (e) => {
      console.error('Global error:', e.error);
          });

    window.addEventListener('unhandledrejection', (e) => {
      console.error('Unhandled promise rejection:', e.reason);
          });
  }
}

document.addEventListener('DOMContentLoaded', () => {
    new ThemeManager();
  new NavigationManager();
  new ScrollAnimations();
  new ContactForm();
  new ProjectCards();
  new ParallaxEffects();
  new RevealAnimations();
  new PerformanceMonitor();
  new ErrorHandler();
  
    setTimeout(() => {
    new TypingAnimation();
  }, 500);

    document.body.classList.add('loaded');
});

const preloadResources = () => {
  const criticalImages = [
    '/5e/logo.png',
    '/bg3-item-viewer/background.png',
    '/stardew-tracker/thumbnail.png'
  ];

  criticalImages.forEach(src => {
    const link = document.createElement('link');
    link.rel = 'preload';
    link.as = 'image';
    link.href = src;
    document.head.appendChild(link);
  });
};

preloadResources();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(registration => {
        console.log('SW registered: ', registration);
      })
      .catch(registrationError => {
        console.log('SW registration failed: ', registrationError);
      });
  });
}

window.PortfolioApp = {
  ThemeManager,
  NavigationManager,
  ContactForm,
  ProjectCards,
  ParallaxEffects,
  RevealAnimations,
  TypingAnimation
};
